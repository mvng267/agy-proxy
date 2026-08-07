import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { mapStatus, retryAfterSec } from '../openai.js';
import {
  anthropicToMessages, anthropicGenerationConfig, anthropicToolDefs, anthropicToolConfig,
  resultToAnthropic, sseFrame, anthropicErrorBody, resolveAnthropicModel, type AnthropicRequest,
} from '../anthropic.js';
import { allModels, parseModelId, PROVIDERS, type ParsedModel } from '../providers/index.js';
import { shouldFallback } from '../combo.js';
import { recordComboRun } from '../../store/db.js';
import { syncFromStore, NoAccountError } from '../pool.js';
import type { ToolCall } from '../antigravity.js';
import { authOk, authCtx, emitGw, resolveComboPlan, runProviderCall, COMBO_MAX_STEPS } from '../engine.js';
import { sseInit } from './wire.js';

/**
 * Dialect Anthropic Messages API (cho Claude Code, Hermes…).
 * Claude Code cấu hình ANTHROPIC_BASE_URL=http://host:port (KHÔNG kèm /v1) rồi tự gọi /v1/messages.
 * Thêm /proxy/v1/messages: client (Hermes…) trỏ base_url vào /proxy/v1 nhưng nói Anthropic
 * Messages API — nó nối '/messages' vào base nên rơi ra ngoài 2 path trên.
 */
const anthropicPaths = ['/v1/messages', '/anthropic/v1/messages', '/proxy/v1/messages'];

/** Kiểm key kiểu Anthropic. Dùng chung `authenticate()` với OpenAI-path (xem authOk). */
const anthropicAuthOk = authOk;

export function registerAnthropicDialect(app: FastifyInstance): void {
  for (const path of anthropicPaths) {
    app.post(path, async (req, reply) => {
      const auth = authCtx(req);
      if (!auth) return reply.code(401).send(anthropicErrorBody(401, 'invalid x-api-key'));
      if (!config.gateway.enabled) return reply.code(503).send(anthropicErrorBody(503, 'gateway disabled'));
      const b = (req.body ?? {}) as AnthropicRequest;
      if (!Array.isArray(b.messages) || !b.messages.length) {
        return reply.code(400).send(anthropicErrorBody(400, 'messages[] là bắt buộc'));
      }
      syncFromStore();

      const wanted = resolveAnthropicModel(b.model, {
        big: config.gateway.anthropicBigModel,
        small: config.gateway.anthropicSmallModel,
      });
      let parsed: ParsedModel;
      try {
        parsed = parseModelId(wanted);
      } catch (e: any) {
        return reply.code(400).send(anthropicErrorBody(400, e.message));
      }

      const messages = anthropicToMessages(b);
      const generationConfig = anthropicGenerationConfig(b);
      const tools = anthropicToolDefs(b);
      const stream = !!b.stream;
      const echoModel = b.model || parsed.prefixed;
      const msgId = 'msg_' + randomUUID().replace(/-/g, '');
      // Một requestId cho CẢ request client — mọi bước combo dùng chung để nối được.
      const requestId = randomUUID();
      // Usage THẬT từ upstream. Trước đây message_delta trả `ceil(outChars/4)` — một con
      // số bịa, khiến client tính nhầm chi phí.
      let realUsage: { promptTokens: number; completionTokens: number } | undefined;

      /** Gọi 1 model; nếu là combo/auto thì thử lần lượt theo kế hoạch (fallback). */
      const call = async (
        target: ParsedModel,
        streamWriter?: (t: string) => void,
        onToolCall?: (c: ToolCall) => void,
      ) => {
        const one = (p: ParsedModel, label?: string) =>
          runProviderCall({
            provider: p.provider!, bare: p.model!, labelModel: p.prefixed,
            messages, stream: !!streamWriter, reply, endpoint: label ?? '/v1/messages',
            sseWriter: streamWriter,
            generationConfig,
            toolConfig: anthropicToolConfig(b),
            tools,
            onToolCall,
            // `label` chỉ có giá trị khi gọi từ nhánh combo → dùng làm tên combo.
            usage: { requestId, apiKeyId: auth.keyId, endpoint: path, stream, combo: label },
            onUsage: (u) => { realUsage = u; },
          });

        if (target.kind === 'provider') return one(target);

        // combo / auto — dùng chung engine với /proxy/v1
        const res = resolveComboPlan(target);
        if ('error' in res) throw Object.assign(new Error(res.error), { status: res.status });
        if (!res.plan.length) throw Object.assign(new Error(`${res.name}: không có model khả dụng`), { status: 503 });
        // Claude Code luôn gửi tools → bỏ bước không hỗ trợ tool-use (trừ bypassTools).
        const steps = tools.length
          ? res.plan.filter((t) => {
              try {
                const p = parseModelId(t.model);
                return p.kind !== 'provider' || !!PROVIDERS[p.provider!]?.supportsTools || !!PROVIDERS[p.provider!]?.bypassTools;
              } catch { return true; }
            })
          : res.plan;
        if (!steps.length) {
          throw Object.assign(new Error(`${res.name}: không có bước nào hỗ trợ tool-use — thêm model agy/ vào combo.`), { status: 400 });
        }
        let lastErr: any;
        for (let step = 0; step < Math.min(steps.length, COMBO_MAX_STEPS); step++) {
          const t0 = Date.now();
          let p: ParsedModel;
          try {
            p = parseModelId(steps[step]!.model);
          } catch (e) { lastErr = e; continue; }
          if (p.kind !== 'provider') continue;
          try {
            const out = await one(p, res.name);
            recordComboRun({ combo: res.name, step, model: p.prefixed, ok: true, ms: Date.now() - t0 });
            return out;
          } catch (e: any) {
            lastErr = e;
            recordComboRun({ combo: res.name, step, model: p.prefixed, ok: false, status: e?.status, ms: Date.now() - t0, reason: String(e?.message ?? e) });
            emitGw({ kind: 'err', account: '-', model: res.name, status: e?.status, msg: `${res.name} bước ${step + 1} (${p.prefixed}) lỗi → ${shouldFallback(e) ? 'trượt tiếp' : 'dừng'}` });
            if (streamWriter && reply.raw.headersSent) throw e; // đã gửi byte → không cứu được
            if (!shouldFallback(e)) throw e;
          }
        }
        throw lastErr ?? new NoAccountError(`${res.name}: mọi bước đều lỗi`);
      };

      try {
        if (!stream) {
          const out = await call(parsed);
          if ('result' in out) return reply.send(resultToAnthropic(echoModel, out.result, msgId));
          return reply;
        }

        // ----- streaming theo đúng thứ tự sự kiện Anthropic -----
        // Mở stream LƯỜI: gửi header + message_start ngay từ đây thì headersSent=true
        // TRƯỚC KHI gọi model, nên bước 1 của combo lỗi 429 sẽ rơi vào nhánh "đã gửi byte
        // → không cứu được" và combo mất hẳn tác dụng khi stream (đo thật: 1/20 request
        // rò 429 ra client dù còn 3 bước dự phòng chưa dùng). Hoãn tới byte THẬT đầu tiên
        // ⇒ mọi lỗi xảy ra trước đó vẫn trượt bước được, và vẫn trả JSON lỗi sạch.
        let started = false;
        const startStream = () => {
          if (started) return;
          started = true;
          sseInit(reply);
          reply.raw.write(sseFrame('message_start', {
            type: 'message_start',
            message: { id: msgId, type: 'message', role: 'assistant', model: echoModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
          }));
        };
        const ping = setInterval(() => { if (started) reply.raw.write(sseFrame('ping', { type: 'ping' })); }, 15_000);
        let outChars = 0;
        let sawTool = false;
        // Mỗi block phải mở/đóng ĐÚNG MỘT LẦN theo index tăng dần. Block text mở LAZY:
        // lượt chỉ gọi tool thì không phát block text rỗng thừa. `textOpen` là block
        // DUY NHẤT có thể còn mở khi tới tool kế (block tool tự đóng ngay sau khi ghi).
        let index = -1;
        let textOpen = false;
        const openText = () => {
          if (textOpen) return;
          startStream();
          index++;
          textOpen = true;
          reply.raw.write(sseFrame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
        };
        const closeText = () => {
          if (!textOpen) return;
          reply.raw.write(sseFrame('content_block_stop', { type: 'content_block_stop', index }));
          textOpen = false;
        };
        try {
          await call(
            parsed,
            (t) => {
              openText();
              outChars += t.length;
              reply.raw.write(sseFrame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } }));
            },
            (c) => {
              sawTool = true;
              startStream();
              closeText(); // chỉ block text mới cần đóng ở đây
              index++;
              const args = JSON.stringify(c.input ?? {});
              outChars += args.length;
              reply.raw.write(sseFrame('content_block_start', {
                type: 'content_block_start', index,
                content_block: {
                  type: 'tool_use', id: c.id, name: c.name, input: {},
                  // Chữ ký Gemini đi kèm để client trả lại ở lượt sau.
                  ...(c.signature ? { _signature: c.signature } : {}),
                },
              }));
              // Gemini trả args nguyên khối → phát 1 delta duy nhất rồi đóng ngay.
              reply.raw.write(sseFrame('content_block_delta', {
                type: 'content_block_delta', index,
                delta: { type: 'input_json_delta', partial_json: args },
              }));
              reply.raw.write(sseFrame('content_block_stop', { type: 'content_block_stop', index }));
            },
          );
          closeText();
          if (index < 0) { // không có byte nào → vẫn phải có 1 block hợp lệ
            openText();
            closeText();
          }
          startStream(); // model im lặng hoàn toàn: vẫn phải mở stream trước khi đóng
          reply.raw.write(sseFrame('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: sawTool ? 'tool_use' : 'end_turn', stop_sequence: null },
            // Ưu tiên số thật; chỉ ước lượng khi upstream không trả usage.
            usage: {
              output_tokens: realUsage?.completionTokens ?? Math.ceil(outChars / 4),
              ...(realUsage ? { input_tokens: realUsage.promptTokens } : {}),
            },
          }));
          reply.raw.write(sseFrame('message_stop', { type: 'message_stop' }));
        } finally {
          clearInterval(ping);
        }
        reply.raw.end();
        return reply;
      } catch (e: any) {
        // Dùng chung mapStatus với dialect OpenAI: 429 upstream phải ra 429 (trước đây
        // thành 502 nên client Anthropic không nhận rate_limit_error và không retry).
        const status = mapStatus(e);
        const ra = retryAfterSec(e);
        if (ra != null && status === 429 && !reply.raw.headersSent) reply.header('retry-after', String(ra));
        if (reply.raw.headersSent) {
          reply.raw.write(sseFrame('error', anthropicErrorBody(status, String(e?.message ?? e))));
          reply.raw.end();
          return reply;
        }
        return reply.code(status).send(anthropicErrorBody(status, String(e?.message ?? e)));
      }
    });
  }

  // `/v1/models` KHÔNG đăng ký ở đây: handler alias bên dialect OpenAI đã phục vụ path đó
  // và tự nhận diện client Anthropic (x-api-key / anthropic-version) để trả đúng schema,
  // lại kèm cả combo. Đăng ký cả hai nơi làm Fastify ném FST_ERR_DUPLICATED_ROUTE lúc khởi
  // động — server không lên được và toàn bộ test API fail.
  for (const path of ['/anthropic/v1/models']) {
    app.get(path, async (req, reply) => {
      if (!anthropicAuthOk(req)) return reply.code(401).send(anthropicErrorBody(401, 'invalid x-api-key'));
      const data = allModels().map((m) => ({
        type: 'model', id: m.prefixed, display_name: `${m.label} (${m.providerLabel})`,
        created_at: new Date(0).toISOString(),
      }));
      return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null };
    });
  }

  for (const path of ['/v1/messages/count_tokens', '/anthropic/v1/messages/count_tokens', '/proxy/v1/messages/count_tokens']) {
    app.post(path, async (req, reply) => {
      // Trước đây KHÔNG kiểm key (đo bằng curl: 200 không cần key), và auth.ts:129 cũng
      // miễn Basic auth cho mọi path `/v1/` → endpoint mở hoàn toàn.
      if (!anthropicAuthOk(req)) return reply.code(401).send(anthropicErrorBody(401, 'invalid x-api-key'));
      const b = (req.body ?? {}) as AnthropicRequest;
      const chars = JSON.stringify(b.messages ?? []).length + JSON.stringify(b.system ?? '').length;
      return { input_tokens: Math.ceil(chars / 4) };
    });
  }
}
