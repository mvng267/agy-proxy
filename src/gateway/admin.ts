import type { FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { config, applyConfig } from '../config.js';
import { createApiKey, listPublicApiKeys, patchApiKey, removeApiKey } from './apikeys.js';
import {
  upsertComboRow, deleteComboRow, comboStatsRows,
  creditsUsedThisMonth, getSetting, setSetting,
} from '../store/db.js';
import {
  PROVIDERS, PROVIDER_IDS, allModels, parseModelId,
  type ParsedModel, type ProviderId,
} from './providers/index.js';
import {
  planAuto, validateTargets, AUTO_VARIANT_IDS, AUTO_VARIANTS, scoreCandidates, shouldFallback,
} from './combo.js';
import {
  pool, syncFromStore, savePersist, geminiPct, claudePct,
  type PoolAccount,
} from './pool.js';
import { isImageModel } from './antigravity.js';
import {
  log, accOf, pickReady, poolSnapshot, modelHealth,
  listCombos, testAccount, checkLiveAccount, emitCheck, runProviderCall,
  resolveComboPlan, COMBO_MAX_STEPS,
} from './engine.js';
import { store } from '../store/index.js';
import { toMessages } from './dialects/wire.js';
import { registerReportRoutes } from './reports.js';
import { registerPoolStatusRoutes } from './poolStatus.js';

/**
 * Admin API cho dashboard: quản lý account/key/config/combo, báo cáo usage & quota,
 * health check. Toàn bộ nằm sau xác thực dashboard (xem src/auth.ts).
 */

/** `agy-94d9…e86c` — đủ để nhận ra key nào, không đủ để dùng. */
function maskKey(k: string): string {
  if (!k) return '';
  if (k.length <= 12) return '•'.repeat(k.length);
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}

/** Chặn hai vòng quét chạy chồng — mỗi vòng đụng cả pool và gọi upstream. */

export function registerAdminRoutes(app: FastifyInstance): void {
  // ---------------- Accounts ----------------
  app.get('/api/gateway/accounts', async (req) => {
    syncFromStore();
    const now = Date.now();
    const q = (req.query ?? {}) as any;
    const only = q.provider && PROVIDERS[q.provider as ProviderId] ? (q.provider as ProviderId) : undefined;
    const used = creditsUsedThisMonth('kr/'); // Kiro không có API usage → đếm tại chỗ
    const withModels = String((req.query as any)?.withModels ?? '') === '1';
    const limit = config.gateway.kiroCreditLimit;
    return {
      counts: Object.fromEntries(PROVIDER_IDS.map((p) => [p, pool.list(p).length])),
      creditLimit: limit,
      accounts: pool.list(only).map((a) => ({
        creditsUsed: a.provider === 'kr' ? used[a.email] ?? 0 : undefined,
        creditsLimit: a.provider === 'kr' ? limit : undefined,
        provider: a.provider,
        providerLabel: PROVIDERS[a.provider].label,
        key: a.key,
        email: a.email,
        enabled: a.enabled,
        health: a.health,
        requests: a.requests,
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
        lastUsed: a.lastUsed,
        /**
         * Lần KIỂM gần nhất — khác `lastUsed` (lúc phục vụ request thật).
         * Không có mốc này thì "alive" không nói được nó là kết quả của 1 phút hay
         * 3 ngày trước, mà độ tin cậy hai trường hợp khác hẳn nhau.
         */
        lastCheckAt: a.lastCheckAt || undefined,
        cooldown: (a.cooldownUntil || 0) > now,
        // Bỏ hẳn trường mang giá trị MẶC ĐỊNH: với 700 account, chở số 0 và chuỗi rỗng
        // qua mạng mỗi 10s là lãng phí thật. Client dùng `?? 0` / `?? ''` như bình thường.
        ...(a.cooldownUntil ? { cooldownUntil: a.cooldownUntil } : {}),
        ...(a.monthlyExhaustedUntil ? { monthlyExhaustedUntil: a.monthlyExhaustedUntil } : {}),
        ...(a.lastError ? { lastError: a.lastError } : {}),
        // `inflight` có trong PoolAccount nhưng trước đây không được map ra — thiếu nó thì
        // không quan sát được account "đang bận", và cũng không kiểm chứng được rò rỉ.
        ...(a.inflight ? { inflight: a.inflight } : {}),
        ...(a.lastAttempt ? { lastAttempt: a.lastAttempt } : {}),
        ...(a.consecutiveFails ? { consecutiveFails: a.consecutiveFails } : {}),
        // Thời điểm cập nhật quota gần nhất + có quá hạn TTL chưa — để UI hiện
        // "cập nhật X phút trước" thay vì hiển thị số cũ như thể vừa đo.
        ...(a.quota?.fetchedAt ? { quotaFetchedAt: a.quota.fetchedAt } : {}),
        ...(a.quota && Date.now() - (a.quota.fetchedAt ?? 0) > (config.gateway.quota?.cacheTtlMin ?? 10) * 60_000
          ? { quotaStale: true }
          : {}),
        ...(a.bucketCooldown ? { bucketCooldown: a.bucketCooldown } : {}),
        /**
         * Payload mặc định KHÔNG kèm `quota` — nó chiếm phần lớn kích thước (models[] 24
         * phần tử/account, groups[] lặp lại % đã có ở `geminiPct`/`claudePct` bên dưới).
         * Trang Pool poll mỗi 10s nên đây là chi phí thật.
         * Trang Quota gọi `?withModels=1` để lấy đầy đủ.
         */
        ...(withModels ? { quota: a.quota ?? null } : {}),
        ...(a.quota?.tier ? { tier: a.quota.tier } : {}),
        ...(geminiPct(a) != null ? { geminiPct: geminiPct(a) } : {}),
        ...(claudePct(a) != null ? { claudePct: claudePct(a) } : {}),
        ...(a.liveStatus ? { liveStatus: a.liveStatus } : {}),
        ...(a.proxyLabel ? { hasProxy: true } : {}),
      })),
    };
  });

  app.post('/api/gateway/accounts/:email/toggle', async (req) => {
    const { email } = req.params as { email: string };
    const { enabled } = (req.body as { enabled?: boolean }) ?? {};
    const a = accOf(req, email);
    if (a) a.enabled = enabled ?? !a.enabled;
    savePersist();
    return { ok: !!a, enabled: a?.enabled };
  });

  app.post('/api/gateway/accounts/bulk', async (req) => {
    const { emails, enabled } = (req.body as { emails?: string[]; enabled?: boolean }) ?? {};
    let n = 0;
    const list = emails && emails.length ? emails : pool.list().map((a) => a.email);
    for (const e of list) {
      const a = e.includes(':') ? pool.getByKey(e) : pool.get(e, 'agy');
      if (a) {
        a.enabled = !!enabled;
        n++;
      }
    }
    savePersist();
    return { updated: n };
  });

  /**
   * Gỡ cooldown hàng loạt. Cần khi một sự cố phía upstream (vd đợt 429 diện rộng, hoặc
   * request sai tham số làm cháy cả pool) parked hàng trăm account: chờ hết cooldown thì
   * lâu, mà lỗi đã sửa xong rồi. KHÔNG đụng tới `health`/`enabled` — chỉ xoá thời gian nghỉ.
   */
  app.post('/api/gateway/accounts/wake', async (req) => {
    const { emails, provider } = (req.body as { emails?: string[]; provider?: ProviderId }) ?? {};
    syncFromStore();
    const now = Date.now();
    const list = emails?.length
      ? emails.map((e) => (e.includes(':') ? pool.getByKey(e) : pool.get(e, provider ?? 'agy')))
      : pool.list(provider && PROVIDERS[provider] ? provider : undefined);
    let woken = 0;
    for (const a of list) {
      if (a && (a.cooldownUntil || 0) > now) {
        a.cooldownUntil = 0;
        a.monthlyExhaustedUntil = 0;
        if (a.liveStatus === 'quota') a.liveStatus = undefined;
        woken++;
      }
    }
    savePersist();
    return { woken };
  });

  /**
   * Gỡ trạng thái `dead` hàng loạt, đưa account về `unknown` để được thử lại.
   *
   * Vì sao cần: `dead` là VĨNH VIỄN — account rơi vào đó thì biến mất khỏi `candidates()`
   * cho tới khi có người kiểm thủ công từng cái. Nhưng nó bị đặt bởi những lỗi có thể
   * nhầm: đo thật trên production có 331/351 account Kiro `dead`, trong đó 313 cái vẫn
   * `liveStatus='ok'` và gọi model được trong 1 giây. Một đợt lỗi hạ tầng thoáng qua đủ
   * để xoá sổ cả provider, mà kiểm lại thủ công 351 account mất ~7 phút.
   *
   * Chỉ đổi `health` — KHÔNG bật account đang tắt, không xoá cooldown. Sau khi gỡ,
   * account phải tự chứng minh còn sống qua lần gọi thật kế tiếp.
   */
  app.post('/api/gateway/accounts/revive', async (req) => {
    const { emails, provider } = (req.body as { emails?: string[]; provider?: ProviderId }) ?? {};
    syncFromStore();
    const list = emails?.length
      ? emails.map((e) => (e.includes(':') ? pool.getByKey(e) : pool.get(e, provider ?? 'agy')))
      : pool.list(provider && PROVIDERS[provider] ? provider : undefined);

    let revived = 0;
    for (const a of list) {
      if (!a || a.health !== 'dead') continue;
      a.health = 'unknown';
      a.lastError = '';
      a.consecutiveFails = 0;
      // Ghi ngược vào store: `syncFromStore` đọc health từ credentials.csv, không xoá ở
      // đó thì lần đồng bộ sau sẽ dựng lại 'dead'.
      store.setCredentialHealth(a.email, a.provider === 'kr' ? 'kiro' : 'agy', 'unknown');
      revived++;
    }
    savePersist();
    log('system', 'info', `Gỡ dead: ${revived} account về trạng thái chưa biết`);
    return { revived };
  });

  // ---------------- API keys (nhiều key, mỗi key 1 user) ----------------
  // Chỉ để ĐỊNH DANH cho báo cáo — mọi key dùng chung model/pool, không giới hạn hạn mức.
  app.get('/api/gateway/keys', async () => ({ keys: listPublicApiKeys() }));

  app.post('/api/gateway/keys', async (req, reply) => {
    const b = (req.body as { name?: string; note?: string }) ?? {};
    const name = (b.name ?? '').trim();
    if (!name) return reply.code(400).send({ ok: false, error: 'Thiếu tên key' });
    const c = createApiKey(name, b.note);
    // `key` thô CHỈ trả đúng lần này — DB chỉ giữ sha256, không thể lấy lại.
    return { ok: true, id: c.id, name: c.name, prefix: c.prefix, key: c.key };
  });

  app.patch('/api/gateway/keys/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body as { name?: string; note?: string; enabled?: boolean }) ?? {};
    if (!patchApiKey(id, b)) return reply.code(404).send({ ok: false, error: 'Không tìm thấy key' });
    return { ok: true };
  });

  app.delete('/api/gateway/keys/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Usage cũ giữ api_key_id mồ côi CÓ CHỦ ĐÍCH — báo cáo lịch sử không được biến mất.
    if (!removeApiKey(id)) return reply.code(404).send({ ok: false, error: 'Không tìm thấy key' });
    return { ok: true };
  });

  // ---------------- Config ----------------
  /**
   * Che apiKey mặc định — trước đây endpoint này trả key NGUYÊN VĂN, nên key rơi vào
   * log proxy, tab Network, ảnh chụp màn hình chia sẻ. Key thật lấy qua
   * `?reveal=1`, một hành động có chủ đích của người dùng (nút "Hiện" ở trang Cấu hình).
   * Key mới (bảng api_keys) KHÔNG bao giờ lộ ở đây: chỉ hiện đúng một lần lúc tạo.
   */
  app.get('/api/gateway/config', async (req) => ({
    enabled: config.gateway.enabled,
    rotation: config.gateway.rotation,
    apiKey: (req.query as any)?.reveal === '1' ? config.gateway.apiKey : maskKey(config.gateway.apiKey),
    apiKeyMasked: (req.query as any)?.reveal !== '1',
    outboundProxy: config.gateway.outboundProxy,
    cooldownSec: config.gateway.cooldownSec,
    quota: config.gateway.quota,
    autoDisable: config.gateway.autoDisable,
    baseUrl: `http://localhost:${config.port}/proxy/v1`,
  }));

  // Tương thích ngược (trang Pool dùng) — nay GHI DB qua setConfig để sống qua restart.
  app.patch('/api/gateway/config', async (req) => {
    const b = (req.body as any) ?? {};
    const patch: Record<string, unknown> = {};
    if (typeof b.enabled === 'boolean') patch.gatewayEnabled = b.enabled;
    if (b.rotation) patch.gatewayRotation = b.rotation;
    if (typeof b.outboundProxy === 'string') patch.gatewayProxy = b.outboundProxy;
    if (typeof b.cooldownSec === 'number') patch.gatewayCooldownSec = b.cooldownSec;
    if (b.quota && typeof b.quota === 'object') {
      if (typeof b.quota.autoRefresh === 'boolean') patch.quotaAutoRefresh = b.quota.autoRefresh;
      if (typeof b.quota.intervalMin === 'number') patch.quotaIntervalMin = b.quota.intervalMin;
      if (typeof b.quota.onCall === 'boolean') patch.quotaOnCall = b.quota.onCall;
      if (typeof b.quota.cacheTtlMin === 'number') patch.quotaCacheTtlMin = b.quota.cacheTtlMin;
    }
    // Tự tắt/bật account theo hạn mức. Nhận cả dạng lồng (`autoDisable:{...}`, giống
    // `quota` ở trên) lẫn dạng phẳng — client cũ và CLI hay gửi phẳng.
    const ad = (b.autoDisable && typeof b.autoDisable === 'object' ? b.autoDisable : b) as any;
    if (typeof ad.enabled === 'boolean' && b.autoDisable) patch.autoDisableEnabled = ad.enabled;
    if (typeof b.autoDisableEnabled === 'boolean') patch.autoDisableEnabled = b.autoDisableEnabled;
    for (const [k, s] of [
      ['hour', 'autoDisableHour'], ['offAtPct', 'autoDisableOffPct'], ['onAtPct', 'autoDisableOnPct'],
    ] as const) {
      if (b.autoDisable && typeof ad[k] === 'number') patch[s] = ad[k];
      if (typeof b[s] === 'number') patch[s] = b[s];
    }
    if (b.regenerateKey) patch.gatewayApiKey = 'agy-' + randomUUID().replace(/-/g, '');
    else if (typeof b.apiKey === 'string') patch.gatewayApiKey = b.apiKey;
    // TRƯỚC ĐÂY vứt `rejected` rồi vẫn trả ok:true — bấm nút mà không có gì đổi và
    // không ai được báo. Nay giá trị bị từ chối đi kèm lý do để UI hiển thị.
    const { changed, rejected } = applyConfig(patch);
    // Key vừa sinh PHẢI trả nguyên văn — đó là lần duy nhất người dùng thấy nó. Ngoài
    // ra thì che, cùng lý do với GET ở trên.
    const justMadeKey = !!b.regenerateKey || typeof b.apiKey === 'string';
    const cfg = { ...config.gateway, apiKey: justMadeKey ? config.gateway.apiKey : maskKey(config.gateway.apiKey) };
    return { ok: rejected.length === 0, changed, rejected, config: cfg };
  });

  /**
   * Danh sách thứ GỌI ĐƯỢC ở trường `model` — gồm cả combo, không chỉ model provider.
   *
   * `allModels()` chỉ trả model thật. Combo cũng gọi được y như model (`combo/<tên>`)
   * nhưng nằm ở nguồn khác, nên mọi UI dùng endpoint này đều không chọn được combo:
   * Chat thử, Gọi API và So sánh model đều thiếu. Người dùng có combo trong tay mà
   * không thử được từ dashboard.
   *
   * `/proxy/v1/models` (dialect OpenAI) đã gộp combo từ trước — hai endpoint lệch nhau
   * là gốc của lỗi này.
   */
  app.get('/api/gateway/models', async () => ({
    models: [
      ...allModels().map((m) => ({
        id: m.prefixed, bare: m.id, label: m.label,
        // `image` giữ lại cho client cũ; UI mới đọc imageIn/imageOut vì `image` từng
        // mang hai nghĩa trái ngược tuỳ provider (sinh ảnh vs nhận ảnh).
        image: m.image, imageIn: m.imageIn ?? false, imageOut: m.imageOut ?? m.image,
        provider: m.provider, providerLabel: m.providerLabel,
        bucket: m.bucket, maxInput: m.maxInput,
        kind: 'model' as const,
      })),
      // Combo chỉ liệt kê cái đang BẬT: combo tắt gọi vào sẽ nhận 503, mời chọn là bẫy.
      ...listCombos()
        .filter((c) => c.enabled)
        .map((c) => ({
          id: `combo/${c.id}`, bare: c.id, label: c.name || c.id,
          // Combo trỏ tới nhiều model khác nhau nên không có khả năng ảnh cố định —
          // để false cho an toàn, UI không mời gửi ảnh vào thứ có thể rơi vào model text.
          image: false, imageIn: false, imageOut: false,
          provider: 'combo' as const, providerLabel: 'Combo',
          bucket: undefined, maxInput: undefined,
          kind: 'combo' as const,
          /** Các bước sẽ thử, theo thứ tự — để UI hiện được combo làm gì. */
          steps: (c.targets ?? []).map((t) => t.model),
          strategy: c.strategy,
        })),
    ],
  }));

  // ---------------- Chat thử ----------------
  // Chat thử qua pool (hoặc ép 1 account) — trả text + images (non-stream, dễ render).
  app.post('/api/gateway/chat', async (req, reply) => {
    const b = req.body as any;
    const messages = toMessages(b);
    const forced = b?.account && b.account !== 'auto' ? String(b.account) : undefined;
    const proxy = b?.proxy ? String(b.proxy) : undefined;
    syncFromStore();
    let parsed: ParsedModel;
    try {
      parsed = parseModelId(b?.model);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message, suggestion: e.suggestion });
    }
    const model = parsed.prefixed;
    const t0 = Date.now();

    /**
     * Tham số sinh — để người thử tự chỉnh, vì mặc định thấp gây hiểu nhầm nặng:
     * model reasoning tiêu maxOutputTokens vào phần suy nghĩ, nên trần thấp trả về
     * `content` RỖNG kèm finishReason "length" — trông y hệt model hỏng.
     * Model ảnh thì bỏ hẳn trần (xem chú thích ở smokeTest).
     */
    const maxOutputTokens = Number(b?.maxTokens) > 0 ? Number(b.maxTokens) : 2000;
    const generationConfig: Record<string, unknown> = isImageModel(model)
      ? {}
      : { maxOutputTokens };
    if (b?.temperature !== undefined && Number.isFinite(Number(b.temperature))) {
      generationConfig.temperature = Number(b.temperature);
    }

    /**
     * Dùng CHUNG engine với /proxy/v1 thay vì tự gọi provider một lần.
     *
     * Bản cũ: pickReady → generate → lỗi là trả 502 luôn. Nên account đầu tiên hết quota
     * là màn "Chat thử" báo 429, dù pool còn hàng trăm account khoẻ — trong khi gọi cùng
     * model qua /proxy/v1 lại thành công. Hai đường cùng một việc mà hành xử khác nhau,
     * và người dùng thử ở đây rồi kết luận nhầm là gateway hỏng.
     *
     * `runProviderCall` lo failover, circuit breaker, ghi usage, cập nhật pool.
     */
    let usedAccount = '';

    /**
     * Combo/auto: tự chạy vòng thay vì gọi `runComboRequest`.
     *
     * `runComboRequest` gửi thẳng response OpenAI qua `reply` (openaiCompletion), trong
     * khi Chat thử/So sánh model cần shape riêng `{ok, account, model, text, images, ms}`
     * để hiện ảnh và metadata. Nên tái dùng `resolveComboPlan` + `shouldFallback` — cùng
     * nguồn kế hoạch với /proxy/v1, chỉ khác chỗ đóng gói kết quả.
     *
     * Trước đây màn này CHẶN combo bằng 400 "chỉ nhận model thật". Nhưng combo mới là
     * thứ hay cần thử nhất: nó có nhiều bước, sai một bước là cả chuỗi hỏng, mà không
     * có chỗ nào thử được từ dashboard.
     */
    if (parsed.kind !== 'provider') {
      const resolved = resolveComboPlan(parsed);
      if ('error' in resolved) return reply.code(resolved.status).send({ ok: false, error: resolved.error });
      const plan = resolved.plan.slice(0, COMBO_MAX_STEPS);
      if (!plan.length) {
        return reply.code(503).send({ ok: false, error: `${resolved.name}: không có model nào khả dụng` });
      }

      const skipKeys = new Set<string>();
      /** Vết từng bước — thứ người dùng cần thấy: bước nào trượt và vì sao. */
      const steps: Array<{ model: string; ok: boolean; ms: number; error?: string }> = [];
      let lastErr: any;

      for (const t of plan) {
        const tp = parseModelId(t.model);
        if (tp.kind !== 'provider') continue; // combo lồng combo: bỏ qua, không đệ quy
        const st = Date.now();
        try {
          const out = await runProviderCall({
            provider: tp.provider!, bare: tp.model!, labelModel: tp.prefixed,
            messages, stream: false, reply, skipKeys, generationConfig,
            forcedEmail: forced, proxyOverride: proxy, endpoint: 'chat-test',
            usage: {
              apiKeyId: 'dashboard', keyName: 'Chat thử', endpoint: 'chat-test',
              requestId: randomUUID(), stream: false, combo: resolved.name,
            },
            onAccount: (email: string) => { usedAccount = email; },
          });
          steps.push({ model: tp.prefixed, ok: true, ms: Date.now() - st });
          const r = 'result' in out ? out.result : undefined;
          return {
            ok: true, account: usedAccount, model: resolved.name,
            /** Bước THẬT SỰ trả lời — combo có thể trượt vài bước trước đó. */
            resolvedModel: tp.prefixed,
            ms: Date.now() - t0,
            text: r?.text, images: r?.images, usage: r?.usage,
            isImage: isImageModel(tp.prefixed),
            steps,
          };
        } catch (e: any) {
          lastErr = e;
          steps.push({ model: tp.prefixed, ok: false, ms: Date.now() - st, error: String(e?.message ?? e).slice(0, 120) });
          // Lỗi của NGƯỜI DÙNG (400 prompt sai, 401 key sai) thì trượt bước cũng vô ích.
          if (!shouldFallback(e)) break;
        }
      }
      return reply.code(lastErr?.status ?? 502).send({
        ok: false, account: usedAccount, model: resolved.name,
        error: lastErr?.message ?? 'Mọi bước trong combo đều thất bại',
        steps,
      });
    }

    try {
      const out = await runProviderCall({
        provider: parsed.provider!,
        bare: parsed.model!,
        labelModel: model,
        messages,
        stream: false,
        reply,
        forcedEmail: forced,
        proxyOverride: proxy,
        endpoint: 'chat-test',
        generationConfig,
        /**
         * `endpoint` ở trên chỉ dùng cho Live Log; cột attribution trong usage lấy từ
         * `usage` này. Không truyền thì mọi request từ Chat thử vào DB với endpoint,
         * api_key_id, request_id đều NULL — không lọc ra được trong Báo cáo.
         */
        usage: {
          apiKeyId: 'dashboard',
          keyName: 'Chat thử',
          endpoint: 'chat-test',
          requestId: randomUUID(),
          stream: false,
        },
        onAccount: (email: string) => { usedAccount = email; },
      });
      if (!('result' in out)) return { ok: true, account: usedAccount, model, ms: Date.now() - t0 };
      const r = out.result;
      return {
        ok: true,
        account: usedAccount,
        model,
        ms: Date.now() - t0,
        text: r.text,
        images: r.images,
        usage: r.usage,
        isImage: isImageModel(model),
      };
    } catch (e: any) {
      // Sau khi đã thử hết account khả dụng mà vẫn lỗi — lúc này 429 là thật.
      return reply.code(e?.status ?? 502).send({
        ok: false,
        account: usedAccount,
        error: e?.message ?? String(e),
      });
    }
  });

  // ---------------- Test lẻ / check hàng loạt ----------------
  app.post('/api/gateway/accounts/:email/test', async (req, reply) => {
    const { email } = req.params as { email: string };
    syncFromStore();
    const a = accOf(req, email);
    if (!a) return reply.code(404).send({ error: 'không có account' });
    const r = await testAccount(a);
    emitCheck(email, 'token', r.alive ? 'alive' : 'dead', r.alive ? 'info' : 'warn');
    return { ok: true, email, ...r };
  });

  app.post('/api/gateway/accounts/:email/checklive', async (req, reply) => {
    const { email } = req.params as { email: string };
    syncFromStore();
    const a = accOf(req, email);
    if (!a) return reply.code(404).send({ error: 'không có account' });
    const r = await checkLiveAccount(a);
    emitCheck(email, 'live', r.status, r.status === 'ok' ? 'info' : r.status === 'quota' ? 'warn' : 'error');
    return { ok: true, email, ...r };
  });

  /** Danh sách account đích cho check hàng loạt: theo emails/khoá ghép, hoặc cả pool. */
  function bulkTargets(emails?: string[]): PoolAccount[] {
    syncFromStore();
    return (emails && emails.length
      ? emails.map((e) => (e.includes(':') ? pool.getByKey(e) : pool.get(e, 'agy'))).filter(Boolean)
      : pool.list()) as PoolAccount[];
  }

  /**
   * Vòng check nền dùng chung cho `check` và `test-bulk` (trước đây 2 bản copy).
   * Nhịp 1.2s/account là BẮT BUỘC: 300ms × 400 account = Google chặn tốc độ endpoint
   * refresh, gần như mọi account sau vài chục cái đầu đều fail → bulk test tự tay giết
   * pool. Đo thật: chạy dày không gỡ được cái nào, giãn ~1.2s thì 100% hồi sinh.
   */
  async function runBulkCheck(targets: PoolAccount[], m: 'token' | 'live' | 'both'): Promise<void> {
    const total = targets.length;
    let i = 0, okc = 0;
    for (const a of targets) {
      i++;
      if (m === 'token' || m === 'both') {
        const r = await testAccount(a);
        emitCheck(a.email, 'token', r.alive ? 'alive' : 'dead', r.alive ? 'info' : 'warn', i, total);
        if (!r.alive) { await new Promise((r) => setTimeout(r, 1200)); continue; } // token chết thì khỏi check live
      }
      if (m === 'live' || m === 'both') {
        const r = await checkLiveAccount(a);
        if (r.status === 'ok') okc++;
        emitCheck(a.email, 'live', r.status, r.status === 'ok' ? 'info' : r.status === 'quota' ? 'warn' : 'error', i, total);
      } else if (m === 'token') {
        okc += a.health === 'alive' ? 1 : 0;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    savePersist();
    log('', 'info', `Check ${m} xong: ${okc}/${total} ok`);
  }

  /** Check hàng loạt token/live/both — chạy nền, emit realtime từng account. */
  app.post('/api/gateway/accounts/check', async (req) => {
    const { emails, mode } = (req.body as { emails?: string[]; mode?: 'token' | 'live' | 'both' }) ?? {};
    const m = mode || 'token';
    const targets = bulkTargets(emails);
    runBulkCheck(targets, m).catch(() => {});
    return { queued: targets.length, mode: m };
  });

  // giữ tương thích: test-bulk = check mode token
  app.post('/api/gateway/accounts/test-bulk', async (req) => {
    const { emails } = (req.body as { emails?: string[] }) ?? {};
    const targets = bulkTargets(emails);
    runBulkCheck(targets, 'token').catch(() => {});
    return { queued: targets.length };
  });

  // ---------------- Check live model ----------------
  app.post('/api/gateway/models/check', async (req) => {
    syncFromStore();
    const q = (req.query ?? {}) as any;
    const want: ProviderId[] =
      q.provider === 'all' || !q.provider ? [...PROVIDER_IDS] : [String(q.provider) as ProviderId];
    const out: { id: string; status: string; ms: number; detail?: string; provider: ProviderId; account?: string }[] = [];
    const accounts: string[] = [];
    for (const pid of want) {
      if (!PROVIDERS[pid]) continue;
      let ctx: Awaited<ReturnType<typeof pickReady>>;
      try {
        ctx = await pickReady(pid, undefined, undefined);
      } catch (e: any) {
        for (const m of PROVIDERS[pid].models) {
          out.push({ id: `${pid}/${m.id}`, provider: pid, status: 'error', ms: 0, detail: e?.message ?? 'no account' });
        }
        continue;
      }
      try {
        const res = await PROVIDERS[pid].checkModelsLive(ctx.session, ctx.dispatcher);
        accounts.push(`${pid}:${ctx.account.email}`);
        for (const r of res) out.push({ ...r, id: `${pid}/${r.id}`, provider: pid, account: ctx.account.email });
        log(ctx.account.email, 'info', `check live model ${pid}: ${res.filter((r) => r.status === 'ok').length}/${res.length} ok`);
      } finally {
        pool.release(ctx.account);
      }
    }
    return { account: accounts.join(', '), models: out };
  });

  /** Dò tay: POST /api/gateway/probe?provider=kr&limit=10 */
  app.post('/api/gateway/probe', async (req) => {
    const q = (req.query ?? {}) as any;
    const pid = (q.provider as ProviderId) || 'kr';
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 10));
    const targets = pool.candidates(Date.now(), pid).filter((a) => a.enabled).slice(0, limit);
    (async () => {
      for (const a of targets) {
        await checkLiveAccount(a).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
      }
      savePersist();
    })().catch(() => {});
    return { queued: targets.length, provider: pid };
  });

  // ---------------- Combo CRUD ----------------
  app.get('/api/combos', async () => {
    const stats = comboStatsRows(Date.now() - 7 * 86400_000);
    return {
      combos: listCombos().map((c) => {
        const s = stats.find((x) => x.combo === `combo/${c.id}`);
        return { ...c, calls: s?.calls ?? 0, fallbacks: s?.fallbacks ?? 0 };
      }),
      autoVariants: AUTO_VARIANT_IDS,
      weights: AUTO_VARIANTS,
    };
  });

  app.post('/api/combos', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const id = String(b.id ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!id) return reply.code(400).send({ ok: false, error: 'thiếu id combo' });
    if (id === 'auto') return reply.code(400).send({ ok: false, error: '"auto" là tên dành riêng' });
    const targets = (Array.isArray(b.targets) ? b.targets : []).map((t: any) =>
      typeof t === 'string' ? { model: t } : { model: String(t.model), weight: t.weight ? Number(t.weight) : undefined },
    );
    const v = validateTargets(targets);
    if (!v.ok) return reply.code(400).send({ ok: false, error: v.error });
    // lưu id đã CHUẨN HOÁ (kr/claude-sonnet-4-5 → kr/claude-sonnet-4.5) để UI hiện đúng
    for (const t of targets) t.model = parseModelId(t.model).prefixed;
    const strategy = ['priority', 'round-robin', 'weighted', 'highest-quota'].includes(b.strategy) ? b.strategy : 'priority';
    upsertComboRow({ id, name: String(b.name ?? id), strategy, targets, enabled: b.enabled !== false });
    return { ok: true, id };
  });

  app.delete('/api/combos/:id', async (req) => {
    const { id } = req.params as { id: string };
    deleteComboRow(id);
    return { ok: true };
  });

  /** Bảng xếp hạng hiện tại của `auto` (đúng thứ tự sẽ thử). */
  app.get('/api/combos/auto/preview', async (req) => {
    const q = (req.query ?? {}) as any;
    const variant = String(q.variant ?? 'default').replace(/^auto\/?/, '') || 'default';
    const snap = poolSnapshot();
    // Cùng dữ liệu mà engine dùng để xếp thật — preview không được nói khác thực tế.
    const mh = modelHealth();
    return {
      variant,
      weights: AUTO_VARIANTS[variant] ?? AUTO_VARIANTS.default,
      snapshot: snap,
      plan: planAuto(variant, snap, mh),
      ranking: scoreCandidates(snap, AUTO_VARIANTS[variant] ?? AUTO_VARIANTS.default!, mh).slice(0, 12),
    };
  });

  /**
   * Thông tin để tool ngoài kết nối vào agyproxy qua CLI hoặc HTTP.
   *
   * Token CLI cho TOÀN QUYỀN điều khiển gateway, nên mặc định trả bản CHE
   * (`agy-1234…cdef`) giống cách `/api/gateway/config` che apiKey. Phải `?reveal=1`
   * mới trả nguyên văn — để token không nằm sẵn trong mọi response, trong cache trình
   * duyệt, hay trong ảnh chụp màn hình người dùng gửi đi.
   *
   * Sinh token nếu chưa có: người dùng mở tab CLI lần đầu là dùng được ngay, không phải
   * SSH vào máy chủ chạy `agyproxy token`.
   */
  app.get('/api/cli/connect', async (req) => {
    let token = getSetting('cliToken');
    if (!token) {
      token = randomBytes(24).toString('base64url');
      setSetting('cliToken', token);
    }
    const reveal = (req.query as any)?.reveal === '1';
    // URL mà tool ngoài phải gọi — lấy từ chính request nên đúng cả khi sau reverse proxy.
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || `127.0.0.1:${config.port}`;
    const proto = (req.headers['x-forwarded-proto'] as string) || (req.protocol ?? 'http');
    const base = `${proto}://${host}`;
    /**
     * Gom mọi thứ tool ngoài cần vào MỘT response, để tab CLI không phải ghép 3 lời gọi.
     *
     * Hai loại secret KHÁC NHAU, dùng nhầm là 401 mà không rõ vì sao:
     *  - `token` (cliToken): điều khiển agyproxy — dashboard, CLI, MCP
     *  - `apiKey` (gatewayApiKey legacy): gọi MODEL qua /proxy/v1 và /v1/messages
     *
     * Key trong bảng `api_keys` KHÔNG lấy lại được (DB chỉ giữ sha256, xem apikeys.ts:104)
     * nên chỉ trả tên + prefix để nhận diện, kèm chỉ dẫn tạo mới ở tab API Keys.
     */
    const gwKey = config.gateway.apiKey;
    return {
      url: base,
      token: reveal ? token : maskKey(token),
      masked: !reveal,
      gatewayUrl: `${base}/proxy/v1`,
      anthropicUrl: base,
      apiKey: gwKey ? (reveal ? gwKey : maskKey(gwKey)) : '',
      hasApiKey: !!gwKey,
      keys: listPublicApiKeys().map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, enabled: k.enabled })),
      models: allModels().map((m) => ({ id: m.prefixed, label: m.label, provider: m.provider })),
      /**
       * Combo cũng gọi được như một model (`combo/<tên>`), nhưng KHÔNG nằm trong
       * `allModels()`. Thiếu ở đây thì hộp hướng dẫn kết nối không biết combo nào tồn
       * tại, và người dùng chỉ phát hiện ra combo khi tình cờ mở trang Combo.
       * Trả kèm chuỗi bước để thấy ngay combo sẽ thử model nào, theo thứ tự nào.
       */
      combos: listCombos().map((c) => ({
        id: `combo/${c.id}`,
        name: c.name,
        strategy: c.strategy,
        enabled: c.enabled,
        steps: (c.targets ?? []).map((t) => t.model),
      })),
    };
  });

  // Nhóm báo cáo (usage, lịch sử combo/hạn mức/metrics) ở `reports.ts` — chúng chỉ ĐỌC.
  registerReportRoutes(app);
  // Hạn mức + trạng thái pool tức thời ở `poolStatus.ts`.
  registerPoolStatusRoutes(app);
}
