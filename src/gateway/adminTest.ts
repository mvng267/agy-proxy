import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PROVIDERS, PROVIDER_IDS, parseModelId, type ParsedModel, type ProviderId } from './providers/index.js';
import { shouldFallback } from './combo.js';
import { pool, syncFromStore, savePersist, type PoolAccount } from './pool.js';
import { isImageModel } from './antigravity.js';
import {
  log, accOf, pickReady, testAccount, checkLiveAccount, emitCheck, runProviderCall,
  resolveComboPlan, COMBO_MAX_STEPS,
} from './engine.js';
import { toMessages } from './dialects/wire.js';

/**
 * Thử nghiệm và kiểm tra: chat thử, test token, check live, dò model.
 *
 * Điểm chung khiến chúng thành một module: mọi endpoint ở đây **gọi upstream thật và
 * tốn quota thật**. Phần còn lại của `admin.ts` chỉ đọc/ghi cấu hình. Ranh giới đó đáng
 * để nhìn thấy được từ tên file — người sửa nhóm này phải biết mình đang tiêu tiền.
 */
export function registerTestRoutes(app: FastifyInstance): void {
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
}
