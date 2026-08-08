import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { openaiGenerationConfig, openaiToolConfig, openaiError } from '../openai.js';
import { allModels, parseModelId, PROVIDERS, type ParsedModel } from '../providers/index.js';
import { AUTO_VARIANT_IDS, shouldFallback } from '../combo.js';
import { recordComboRun } from '../../store/db.js';
import { syncFromStore, NoAccountError } from '../pool.js';
import { MAX_OUTPUT_TOKENS_CAP } from '../anthropic.js';
import type { ChatMessage } from '../antigravity.js';
import {
  authOk, authCtx, listCombos, resolveComboPlan, runProviderCall, runComboRequest,
  COMBO_MAX_STEPS, type UsageCtx,
} from '../engine.js';
import { toMessages, toToolDefs, openaiCompletion, sendOpenAIError, contextHint } from './wire.js';

/**
 * Dialect OpenAI: /proxy/v1/* + các alias /v1, /openai/v1 (chat completions, models,
 * responses). Chỉ lo chuyện wire-format OpenAI — mọi việc chọn account/failover/combo
 * nằm ở engine.
 */
export function registerOpenAIDialect(app: FastifyInstance): void {
  app.get('/proxy/v1/models', async (req, reply) => {
    if (!authOk(req)) return reply.code(401).send(openaiError(401, 'unauthorized'));
    const q = (req.query ?? {}) as any;
    /**
     * Gateway trung gian (OmniRoute, LiteLLM…) TỰ THÊM prefix provider của nó vào id,
     * nên id `agy/gemini-…` của ta sẽ thành `agy/agy/gemini-…` (prefix chồng prefix).
     * Với các gateway đó, gọi `?bare=1` để lấy id TRẦN, kèm đuôi phân biệt provider
     * (`-kr`) cho model trùng tên giữa 2 provider.
     */
    const bare = q.bare === '0' || q.bare === 'false' ? false : q.bare === '1' || q.bare === 'true' || config.gateway.bareModels;
    const all = allModels();
    // Trùng tên giữa 2 provider, HOẶC trùng tên dành riêng cho combo ảo ('auto') →
    // model Kiro được thêm đuôi '-kr' để id vẫn duy nhất khi bỏ prefix.
    const reserved = new Set<string>(['auto', ...AUTO_VARIANT_IDS]);
    const dupes = new Set(
      all.map((m) => m.id).filter((id, i, arr) => arr.indexOf(id) !== i || reserved.has(id)),
    );
    const data = all.map((m) => ({
      id: bare ? (dupes.has(m.id) && m.provider === 'kr' ? `${m.id}-kr` : m.id) : m.prefixed,
      object: 'model',
      owned_by: m.providerLabel.toLowerCase(),
    }));
    // combo do người dùng tạo + combo ảo auto
    for (const c of listCombos()) data.push({ id: `combo/${c.id}`, object: 'model', owned_by: 'combo' });
    for (const v of AUTO_VARIANT_IDS) data.push({ id: v, object: 'model', owned_by: 'combo' });
    /**
     * Client Anthropic (Hermes…) trỏ base_url vào /proxy/v1 sẽ gọi ĐÚNG route này để xác
     * minh model, nhưng chờ schema Anthropic (`type`/`display_name`) chứ không phải OpenAI
     * (`object`/`owned_by`). Nhận diện qua header đặc trưng rồi trả đúng schema — nếu không
     * client coi như không xác minh được và chấp nhận bừa mọi tên model.
     */
    if (req.headers['x-api-key'] || req.headers['anthropic-version']) {
      const items = data.map((m) => ({
        type: 'model', id: m.id,
        display_name: all.find((x) => x.prefixed === m.id || x.id === m.id)?.label ?? m.id,
        created_at: new Date(0).toISOString(),
      }));
      return { data: items, has_more: false, first_id: items[0]?.id ?? null, last_id: items[items.length - 1]?.id ?? null };
    }
    return { object: 'list', data };
  });

  /** OpenAI retrieve-model: `GET /proxy/v1/models/:id` — vài gateway gọi để xác thực model. */
  app.get('/proxy/v1/models/:id', async (req, reply) => {
    if (!authOk(req)) return reply.code(401).send({ error: { message: 'unauthorized' } });
    const raw = decodeURIComponent((req.params as any).id ?? '');
    try {
      const p = parseModelId(raw);
      return {
        id: raw,
        object: 'model',
        created: 0,
        owned_by: p.kind === 'provider' ? PROVIDERS[p.provider!].label.toLowerCase() : 'combo',
      };
    } catch (e: any) {
      return reply.code(404).send({ error: { message: e?.message ?? 'model not found', type: 'invalid_request_error' } });
    }
  });

  // Chat completions: /proxy/v1 + các alias không prefix (Claude CLI, opencode, Cursor,
  // Aider dùng base_url=http://host:port/v1 và tự nối /chat/completions).
  for (const path of ['/proxy/v1/chat/completions', '/v1/chat/completions', '/openai/v1/chat/completions']) {
    app.post(path, async (req, reply) => {
      const auth = authCtx(req);
      if (!auth) return reply.code(401).send(openaiError(401, 'unauthorized'));
      if (!config.gateway.enabled) return reply.code(503).send(openaiError(503, 'gateway disabled'));
      const body = req.body as any;
      const messages = toMessages(body);
      const tools = toToolDefs(body);
      const stream = !!body?.stream;
      const usage: UsageCtx = { requestId: randomUUID(), apiKeyId: auth.keyId, keyName: auth.keyName, endpoint: path, stream };
      // TRƯỚC ĐÂY không dựng generationConfig → max_tokens/temperature/top_p bị bỏ hoàn toàn.
      const generationConfig = openaiGenerationConfig(body);
      const toolConfig = openaiToolConfig(body);
      syncFromStore();

      let parsed: ParsedModel;
      try {
        parsed = parseModelId(body?.model);
      } catch (e: any) {
        return reply.code(400).send(openaiError(400, e.message, { param: 'model', suggestion: e.suggestion }));
      }

      try {
        // combo / auto → engine combo tự lo fallback
        if (parsed.kind !== 'provider') {
          return await runComboRequest(parsed, { messages, tools, stream, reply, runProviderCall, usage, generationConfig, toolConfig });
        }
        // KHÔNG sseInit() eager: sseChunk() tự mở stream ở byte dữ liệu THẬT đầu tiên.
        // Gửi header trước khi gọi model làm headersSent=true ngay, nên account đầu lỗi
        // 429/5xx rơi vào nhánh "đã gửi byte → hết cứu" và direct-model mất failover khi stream.
        const out = await runProviderCall({
          provider: parsed.provider!, bare: parsed.model!, labelModel: parsed.prefixed,
          messages, tools, stream, reply, usage, generationConfig, toolConfig,
        });
        if ('done' in out) return reply;
        return reply.send(openaiCompletion(parsed.prefixed, out.result));
      } catch (e: any) {
        return sendOpenAIError(reply, e, parsed.prefixed);
      }
    });
  }

  // /v1/models alias (OpenAI format, không có /proxy prefix)
  for (const path of ['/v1/models', '/openai/v1/models']) {
    app.get(path, async (req, reply) => {
      // Trước đây KHÔNG kiểm key (đo bằng curl: `/v1/models` → 200 không cần key), trong
      // khi `/proxy/v1/models` và `/openai/v1/models` đều 401. Lỗ hổng do handler không
      // gọi hàm auth nào + auth.ts:129 miễn Basic auth cho mọi path `/v1/`.
      if (!authOk(req)) return reply.code(401).send(openaiError(401, 'unauthorized'));
      const all = allModels();
      const data: { id: string; object: string; owned_by: string }[] = all.map((m) => ({ id: m.prefixed, object: 'model', owned_by: m.provider as string }));
      for (const c of listCombos()) data.push({ id: `combo/${c.id}`, object: 'model', owned_by: 'combo' });
      for (const v of AUTO_VARIANT_IDS) data.push({ id: v, object: 'model', owned_by: 'combo' });
      // Nếu client gọi Anthropic format → trả Anthropic schema
      if ((req.headers as any)['x-api-key'] || (req.headers as any)['anthropic-version']) {
        const items = data.map((m) => ({
          type: 'model', id: m.id,
          display_name: all.find((x) => x.prefixed === m.id || x.id === m.id)?.label ?? m.id,
          created_at: new Date(0).toISOString(),
        }));
        return { data: items, has_more: false, first_id: items[0]?.id ?? null, last_id: items[items.length - 1]?.id ?? null };
      }
      return { object: 'list', data };
    });
  }

  /**
   * OpenAI **Responses API** — `POST /proxy/v1/responses`.
   * OmniRoute/Codex gọi đường này thay cho /chat/completions (wire_api="responses").
   * Không có nó thì báo: `404 Route POST:/proxy/v1/responses not found`.
   */
  app.post('/proxy/v1/responses', async (req, reply) => {
    const auth = authCtx(req);
    if (!auth) return reply.code(401).send({ error: { message: 'unauthorized', type: 'authentication_error' } });
    if (!config.gateway.enabled) return reply.code(503).send({ error: { message: 'gateway disabled' } });
    const b = (req.body ?? {}) as any;
    const requestId = randomUUID();

    let parsed: ParsedModel;
    try {
      parsed = parseModelId(b?.model);
    } catch (e: any) {
      return reply.code(400).send({ error: { message: e?.message, type: 'invalid_request_error', param: 'model' } });
    }

    // input: chuỗi, hoặc mảng {role, content} với content là chuỗi/mảng khối
    const messages: ChatMessage[] = [];
    if (b.instructions) messages.push({ role: 'system', content: String(b.instructions) });
    const pushPart = (role: any, content: any) => {
      if (typeof content === 'string') messages.push({ role, content });
      else if (Array.isArray(content)) {
        const text = content
          .map((c: any) => (typeof c === 'string' ? c : c?.text ?? c?.input_text ?? ''))
          .filter(Boolean)
          .join('\n');
        if (text) messages.push({ role, content: text });
      }
    };
    if (typeof b.input === 'string') messages.push({ role: 'user', content: b.input });
    else if (Array.isArray(b.input)) for (const it of b.input) pushPart(it?.role ?? 'user', it?.content ?? it);
    if (!messages.some((m) => m.role !== 'system')) messages.push({ role: 'user', content: '' });

    const generationConfig: Record<string, unknown> = {};
    // Cùng trần với nhánh Anthropic — vượt 64K thì Google trả 429 trần, xem MAX_OUTPUT_TOKENS_CAP.
    if (typeof b.max_output_tokens === 'number') {
      generationConfig.maxOutputTokens = Math.min(b.max_output_tokens, MAX_OUTPUT_TOKENS_CAP);
    }
    if (typeof b.temperature === 'number') generationConfig.temperature = b.temperature;
    if (typeof b.top_p === 'number') generationConfig.topP = b.top_p;

    try {
      syncFromStore();
      // stream của Responses API có bộ sự kiện riêng → v1 trả nguyên khối cho chắc
      // Account đã lỗi trong request này — chia sẻ qua các bước combo (như /chat/completions).
      const skipKeys = new Set<string>();
      const one = (p: ParsedModel, combo?: string) =>
        runProviderCall({
          provider: p.provider!, bare: p.model!, labelModel: p.prefixed,
          messages, stream: false, reply, endpoint: '/proxy/v1/responses',
          generationConfig, skipKeys,
          usage: { requestId, apiKeyId: auth.keyId, keyName: auth.keyName, endpoint: '/proxy/v1/responses', stream: false, combo },
        } as any);

      let out: any;
      let usedModel = parsed.prefixed;
      if (parsed.kind === 'provider') {
        out = await one(parsed);
      } else {
        const res = resolveComboPlan(parsed);
        if ('error' in res) return reply.code(res.status).send({ error: { message: res.error } });
        let lastErr: any;
        // Cùng trần bước với /chat/completions và /v1/messages — trước đây chặn cứng 3
        // khiến combo dài hơn 3 có bước không bao giờ chạy trên riêng Responses API.
        for (let step = 0; step < Math.min(res.plan.length, COMBO_MAX_STEPS); step++) {
          const t0 = Date.now();
          let p: ParsedModel;
          try { p = parseModelId(res.plan[step]!.model); } catch (e) { lastErr = e; continue; }
          if (p.kind !== 'provider') continue;
          try {
            out = await one(p, res.name);
            usedModel = res.name;
            recordComboRun({ combo: res.name, step, model: p.prefixed, ok: true, ms: Date.now() - t0 });
            break;
          } catch (e: any) {
            lastErr = e;
            recordComboRun({ combo: res.name, step, model: p.prefixed, ok: false, status: e?.status, ms: Date.now() - t0, reason: String(e?.message ?? e) });
            if (!shouldFallback(e)) throw e;
          }
        }
        if (!out) throw lastErr ?? new NoAccountError(`${res.name}: mọi bước đều lỗi`);
      }

      const r = out.result;
      let text = r.text;
      for (const img of r.images ?? []) text += (text ? '\n\n' : '') + `![image](${img})`;
      return reply.send({
        id: 'resp_' + randomUUID().replace(/-/g, ''),
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: usedModel,
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_' + randomUUID().replace(/-/g, ''),
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        ],
        output_text: text, // tiện cho client đọc thẳng
        usage: {
          input_tokens: r.usage.promptTokens,
          output_tokens: r.usage.completionTokens,
          total_tokens: r.usage.totalTokens,
        },
      });
    } catch (e: any) {
      const code = e instanceof NoAccountError ? 503 : e?.status === 400 ? 400 : 502;
      const hint = contextHint(e, parsed.prefixed);
      return reply.code(code).send({ error: { message: hint ?? e?.message ?? 'all accounts failed', type: 'api_error' } });
    }
  });
}
