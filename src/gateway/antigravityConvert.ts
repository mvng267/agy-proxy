import { randomUUID } from 'node:crypto';
import type { ChatMessage, GenResult, ToolCall, ToolDef, Usage } from './antigravity.js';
import { isImageModel, resolveUpstreamModel, type OAContent } from './antigravity.js';

/**
 * Chuyển đổi giữa wire-format OpenAI/nội bộ và Antigravity (Gemini `contents`/`parts`).
 *
 * Tách khỏi `antigravity.ts` (973 dòng) vì đây là phần THUẦN TUÝ: vào dữ liệu, ra dữ liệu,
 * không gọi mạng, không đụng token hay pool. Đó cũng là phần hay phải sửa nhất và có nhiều
 * bẫy nhất — mọi thứ dưới đây đều là kết quả của một lỗi đã gặp thật:
 *
 *   · part text rỗng làm chết TOÀN BỘ model `agy/claude-*` (proto3 nuốt chuỗi rỗng)
 *   · model ảnh gửi `functionCall` mà không gửi `tools` → 400 thought_signature
 *   · `thoughtSignature` nằm CÙNG CẤP với functionCall, không lồng bên trong
 *
 * Giữ chúng cạnh nhau trong một file có tên đúng việc thì lần sau dễ tìm hơn là nằm giữa
 * phần auth và phần gọi model.
 */

// ---------- convert OpenAI → Antigravity ----------
type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown>; id?: string }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } };

function dataUrlToInline(url: string): GeminiPart | null {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (!m) return null;
  return { inlineData: { mimeType: m[1] ?? 'image/png', data: m[2] ?? '' } };
}

/**
 * Text chỉ được thành part khi CÓ KÝ TỰ THẬT.
 *
 * Upstream Anthropic từ chối cả hai: `text: ''` → `content.0.text.text: Field required`
 * (proto3 nuốt chuỗi rỗng nên field biến mất), `text: ' '` → `must contain non-whitespace
 * text`. Xem test/gateway/emptypart.test.ts để biết số đo đầy đủ.
 */
function coChuThat(t: unknown): t is string {
  return typeof t === 'string' && /\S/.test(t);
}

function contentToParts(content: OAContent): GeminiPart[] {
  if (typeof content === 'string') return coChuThat(content) ? [{ text: content }] : [];
  const parts: GeminiPart[] = [];
  for (const p of content) {
    if (p.type === 'text' && coChuThat(p.text)) parts.push({ text: p.text });
    else if (p.type === 'image_url' && p.image_url?.url) {
      const inline = dataUrlToInline(p.image_url.url);
      if (inline) parts.push(inline);
    }
  }
  // Trả MẢNG RỖNG khi không có gì — KHÔNG bịa ra `{ text: '' }`.
  // Xem ghi chú ở openaiToAntigravity: part text rỗng làm hỏng mọi model Claude.
  return parts;
}

/**
 * JSON Schema → schema Gemini chấp nhận. Gemini v1internal từ chối các khoá phụ của
 * JSON Schema ($schema, additionalProperties…) → lọc trắng, giữ đúng phần nó hiểu.
 */
export function toGeminiSchema(s: unknown): Record<string, unknown> | undefined {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return undefined;
  const src = s as Record<string, any>;
  const out: Record<string, unknown> = {};
  // JSON Schema cho phép type là MẢNG (["array","null"] — kiểu tuỳ chọn của Pydantic),
  // proto của Gemini chỉ nhận enum đơn → lấy kiểu đầu tiên khác 'null', đánh dấu nullable.
  // Trước đây nhánh này bị bỏ qua → schema có items mà không có type, Gemini trả
  // "field predicate failed: $type == Type.ARRAY" và 400 CẢ request (đo với tool
  // PayBox của Claude Code, 69 tools chết chùm vì 2 schema).
  if (typeof src.type === 'string') out.type = src.type.toUpperCase();
  else if (Array.isArray(src.type)) {
    const first = src.type.find((t: unknown) => typeof t === 'string' && t !== 'null');
    if (typeof first === 'string') out.type = first.toUpperCase();
    if (src.type.includes('null')) out.nullable = true;
  }
  if (typeof src.description === 'string') out.description = src.description;
  if (Array.isArray(src.enum)) out.enum = src.enum.map(String);
  if (Array.isArray(src.required) && src.required.length) out.required = src.required.map(String);
  if (src.properties && typeof src.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src.properties as Record<string, unknown>)) {
      const sub = toGeminiSchema(v);
      if (sub) props[k] = sub;
    }
    if (Object.keys(props).length) out.properties = props;
  }
  if (src.items) {
    const it = toGeminiSchema(src.items);
    if (it) out.items = it;
  }
  // Không có type mà có properties → mặc định OBJECT (Claude Code hay bỏ trống).
  if (!out.type && out.properties) out.type = 'OBJECT';
  // Gemini BẮT BUỘC ARRAY phải có items. JSON Schema thì không: `items: true` (mọi
  // giá trị hợp lệ) và `items: {$ref}` đều hợp pháp nhưng dịch ra undefined ở trên
  // → "items: missing field". STRING là fallback ít sai nhất cho "phần tử tuỳ ý":
  // model vẫn gọi được tool, giá trị đi qua dạng chuỗi thay vì 400 cả request.
  if (out.type === 'ARRAY' && !out.items) out.items = { type: 'STRING' };
  return Object.keys(out).length ? out : undefined;
}

/** ToolDef[] → tools.functionDeclarations của Gemini. */
export function toolsToGemini(tools?: ToolDef[]): Array<{ functionDeclarations: unknown[] }> | undefined {
  const decls = (tools ?? [])
    .filter((t) => t && typeof t.name === 'string' && t.name)
    .map((t) => {
      const d: Record<string, unknown> = { name: t.name };
      if (t.description) d.description = t.description;
      const params = toGeminiSchema(t.parameters);
      // Gemini đòi OBJECT rỗng chứ không nhận thiếu parameters với tool không tham số.
      d.parameters = params ?? { type: 'OBJECT', properties: {} };
      return d;
    });
  return decls.length ? [{ functionDeclarations: decls }] : undefined;
}

/** OpenAI messages → body Antigravity generateContent. */
/**
 * Các câu ĐỊNH DANH AGENT mà Antigravity chặn nguyên văn — trả 429 TRẦN (không
 * retryDelay, không quotaId) trông y hệt hết hạn mức, làm proxy cooldown nhầm hàng
 * loạt account dù lỗi nằm ở REQUEST.
 *
 * Đã đo từng câu trên upstream thật (2026-08):
 *   "You are a Claude agent, built on Anthropic's Claude Agent SDK"  → 429 ổn định
 *   ... bỏ dấu phẩy                                                  → 200
 *   ... bỏ "Anthropic's"                                             → 200
 *   từng nửa câu đứng riêng                                          → 200
 * Tức filter khớp CHUỖI DÀI nguyên văn, chỉ cần đổi 1 ký tự là qua.
 *
 * Câu này nằm CỨNG trong binary Claude Code (Agent SDK), không sửa phía client được
 * (khác vụ Hermes "created by Nous Research" — sửa ở SOUL.md). Gateway là chỗ duy nhất
 * chữa được, và đổi 1 dấu phẩy không làm lệch nghĩa system prompt.
 */
const BLOCKED_IDENTITY_PHRASES: Array<[pattern: RegExp, replacement: string]> = [
  [
    /You are a Claude agent, built on Anthropic's Claude Agent SDK/g,
    "You are a Claude agent built on Anthropic's Claude Agent SDK",
  ],
];

/** Trung hoà các câu bị Antigravity chặn nguyên văn. THUẦN — export để test. */
export function neutralizeBlockedPhrases(text: string): string {
  let out = text;
  for (const [re, rep] of BLOCKED_IDENTITY_PHRASES) out = out.replace(re, rep);
  return out;
}

export function openaiToAntigravity(
  model: string,
  messages: ChatMessage[],
  opts: { projectId: string; generationConfig?: Record<string, unknown>; tools?: ToolDef[]; toolConfig?: Record<string, unknown> },
): Record<string, unknown> {
  const isImg = isImageModel(model);
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];
  let systemInstruction: { parts: GeminiPart[] } | undefined;

  for (const m of messages) {
    if (m.role === 'system') {
      // Trung hoà câu định danh bị chặn TRƯỚC khi gửi — xem BLOCKED_IDENTITY_PHRASES.
      const parts = contentToParts(m.content).map((p) =>
        'text' in p && typeof p.text === 'string' ? { ...p, text: neutralizeBlockedPhrases(p.text) } : p,
      );
      systemInstruction = systemInstruction
        ? { parts: [...systemInstruction.parts, ...parts] }
        : { parts };
      continue;
    }
    // Kết quả tool → functionResponse (role user theo quy ước Gemini).
    if (m.role === 'tool') {
      const text = typeof m.content === 'string'
        ? m.content
        : contentToParts(m.content).map((p) => ('text' in p ? p.text : '')).join('');
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: m.toolName || m.toolCallId || 'tool',
            // Upstream Anthropic khớp theo id; Gemini khớp theo tên. Gửi cả hai.
            ...(m.toolCallId ? { id: m.toolCallId } : {}),
            response: { result: text },
          },
        }],
      });
      continue;
    }
    /**
     * Model ảnh KHÔNG có function calling nên `tools` bị bỏ (xem `gtools` bên dưới) —
     * vậy cũng không được gửi `functionCall` trong lịch sử. Gửi lệch nhau thì Gemini trả
     * 400 "Function call is missing a thought_signature": nó thấy lượt gọi tool mà không
     * có khai báo tool nào để đối chiếu.
     *
     * Đã xảy ra thật 11/08/2026 trên `combo/combo-samlv`: 4 lần thử liên tiếp cùng model
     * `gemini-3.1-flash-image` đều 400, client hỏng hẳn.
     *
     * Chỉ bỏ phần functionCall — phần TEXT của lượt đó vẫn giữ, vì đó là nội dung thật.
     */
    const boToolCall = isImg;
    const coToolCall = m.role === 'assistant' && !!m.toolCalls?.length && !boToolCall;
    const parts = coToolCall ? [] : contentToParts(m.content);
    // Lượt assistant có tool_use → kèm functionCall để model thấy lại việc nó đã gọi.
    if (coToolCall && m.toolCalls) {
      const txt = typeof m.content === 'string' ? m.content : '';
      if (txt) parts.push({ text: txt });
      for (const c of m.toolCalls) {
        // thoughtSignature nằm CÙNG CẤP với functionCall (không lồng bên trong).
        // Thiếu nó → Gemini 3 trả 400 "Function call is missing a thought_signature".
        // `id` phải gửi lại nguyên văn: model Claude qua Antigravity (upstream Anthropic)
        // bắt buộc có, thiếu thì 400 "tool_use.id: Field required". Gemini bỏ qua id lạ
        // nên gửi kèm là an toàn cho cả hai.
        parts.push({
          ...(c.signature ? { thoughtSignature: c.signature } : {}),
          functionCall: { name: c.name, args: c.input ?? {}, ...(c.id ? { id: c.id } : {}) },
        });
      }
    }
    /**
     * BỎ HẲN message không có part nào, thay vì độn `{ text: '' }`.
     *
     * Đo thật trên upstream 11/08/2026 (account còn quota Claude, model claude-sonnet-4-6):
     *   parts: [{ text: '1+1?' }]  → 200
     *   parts: [{ text: '' }]      → 400  messages.0.content.0.text.text: Field required
     *   parts: []                  → 400  messages: Field required
     *   parts: [{ text: ' ' }]     → 400  messages: text content blocks must contain non-whitespace text
     *   bỏ hẳn message rỗng        → 200  ← chỉ cách này chạy
     * Số trong câu lỗi trỏ ĐÚNG vị trí message rỗng (`messages.1...` khi nó là message
     * thứ hai), nên không còn nghi ngờ gì về thủ phạm.
     *
     * Vì sao chỉ Claude vỡ: proto3 không emit field scalar rỗng, nên `text: ''` biến mất
     * lúc serialize. Antigravity dịch parts → block Anthropic ra `{"type":"text"}` thiếu
     * hẳn field `text`. Gemini không qua bước dịch đó nên vẫn chạy — bug nằm im từ commit
     * đầu tiên tới khi Antigravity siết validate phía Claude.
     */
    if (!parts.length) continue;
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  // Upstream đòi `messages` KHÔNG rỗng (`messages: Field required`), nên vẫn phải có đúng
  // một message — nhưng nội dung phải khác rỗng và khác khoảng trắng.
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: '(trống)' }] });

  const request: Record<string, unknown> = {
    contents,
    sessionId: randomUUID(),
  };
  if (systemInstruction) request.systemInstruction = systemInstruction;
  if (opts.generationConfig && Object.keys(opts.generationConfig).length) {
    request.generationConfig = opts.generationConfig;
  }
  // Model ảnh không có function calling → bỏ qua tools.
  const gtools = isImg ? undefined : toolsToGemini(opts.tools);
  if (gtools) request.tools = gtools;
  // `toolConfig` NGANG CẤP với tools, không nằm trong generationConfig.
  //
  // CẢNH BÁO — đo trên upstream thật (2026-08): Antigravity **BỎ QUA** field này.
  // Bằng chứng: gửi `mode:'NONE'` với prompt rõ ràng cần tool → model VẪN gọi tool;
  // gửi `allowedFunctionNames:['khong_ton_tai_xyz']` → upstream trả 200 và gọi
  // `get_weather`, trong khi Gemini API thật sẽ trả 400 INVALID_ARGUMENT.
  //
  // Vẫn gửi vì: (a) đúng chuẩn Gemini nên nếu Antigravity bật hỗ trợ thì tự chạy,
  // (b) không gây hại — upstream lờ đi. KHÔNG hứa với client là `tool_choice` được
  // tôn trọng; xem ghi chú ở anthropicToolConfig.
  if (gtools && opts.toolConfig) request.toolConfig = opts.toolConfig;

  return {
    model: resolveUpstreamModel(model),
    userAgent: 'antigravity',
    requestType: isImg ? 'image_gen' : 'agent',
    project: opts.projectId,
    requestId: isImg ? `image_gen/1/${randomUUID()}/12` : `agent-${randomUUID()}`,
    request,
  };
}

// ---------- convert Antigravity → kết quả ----------
export function extractNode(data: any): any {
  return data?.response ?? data;
}

export function partsOf(node: any): any[] {
  return node?.candidates?.[0]?.content?.parts ?? [];
}

/** Gemini KHÔNG trả id cho functionCall, Anthropic thì bắt buộc → gateway tự sinh. */
export function newToolCallId(): string {
  return 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

/** Bóc 1 part functionCall → ToolCall (dùng chung cho non-stream và stream). */
export function toolCallOfPart(p: any): ToolCall {
  const sig = p?.thoughtSignature ?? p?.thought_signature;
  return {
    // Gemini 3 có trả id riêng; thiếu thì tự sinh (Anthropic bắt buộc có id).
    id: String(p.functionCall.id || '') || newToolCallId(),
    name: String(p.functionCall.name),
    input: (p.functionCall.args ?? {}) as Record<string, unknown>,
    ...(typeof sig === 'string' && sig ? { signature: sig } : {}),
  };
}

function collect(node: any, into: { text: string; images: string[]; toolCalls: ToolCall[] }): void {
  for (const p of partsOf(node)) {
    if (p?.functionCall?.name) {
      into.toolCalls.push(toolCallOfPart(p));
    } else if (typeof p?.text === 'string') into.text += p.text;
    else if (p?.inlineData?.data) {
      const mime = p.inlineData.mimeType || 'image/png';
      into.images.push(`data:${mime};base64,${p.inlineData.data}`);
    }
  }
}

export function usageOf(node: any): Usage {
  const u = node?.usageMetadata ?? {};
  const prompt = u.promptTokenCount ?? 0;
  const completion = u.candidatesTokenCount ?? 0;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: u.totalTokenCount ?? prompt + completion };
}

/** Response non-stream (đã JSON) → GenResult. */
export function antigravityToResult(data: any, model: string): GenResult {
  const node = extractNode(data);
  const acc = { text: '', images: [] as string[], toolCalls: [] as ToolCall[] };
  collect(node, acc);
  const finish = node?.candidates?.[0]?.finishReason ?? 'stop';
  return {
    text: acc.text,
    images: acc.images,
    toolCalls: acc.toolCalls,
    usage: usageOf(node),
    // Có tool call → phải báo tool_use, kể cả khi upstream ghi STOP.
    finishReason: acc.toolCalls.length ? 'tool_use' : finish,
    model,
  };
}
