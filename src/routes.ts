import type { FastifyInstance } from 'fastify';
import { store } from './store/index.js';
import type { Account, FlowKey, Proxy, TargetStatus } from './store/models.js';
import { FLOW_KEYS } from './store/models.js';
import { scheduler } from './queue/scheduler.js';
import { runSingle, PIPELINE } from './flows/index.js';
import { resumeHuman, skipHuman, pendingHumanRuns } from './flows/runner.js';
import { recentRuns, runLogs, lastRunErrors, failureReasons } from './store/db.js';
import { fetchWebshareList, parseProxyList, testProxy } from './proxy/webshare.js';
import { config, CSV, saveSettings, setConfig, applyConfig, getConfigValue, CONFIG_KEYS, SECRET_KEYS, RESTART_KEYS, AGY_HOME, ROOT } from './config.js';
import { checkAll, restartHealthLoop } from './health/tokenHealth.js';
import { checkUpdate, runUpdate } from './updater.js';
import { hashPassword, verifyPassword, isWeakPasscode, isPasscode } from './security.js';
import { registerGatewayRoutes } from './gateway/routes.js';
import { registerToolRoutes } from './tools/routes.js';
import { buildBackup, restoreBackup } from './backup.js';
import { pool, geminiPct } from './gateway/pool.js';
import { tuoiQuota } from './gateway/poolScore.js';
import { PROVIDERS, PROVIDER_IDS } from './gateway/providers/index.js';
import { usageTotals, usageSeries, usageByModel, usageByAccount, usageByProvider } from './store/db.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function pkgVersion(): string {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version ?? '';
  } catch {
    return '';
  }
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Gateway "API proxy AGY" (OpenAI-compatible pool Antigravity)
  await registerGatewayRoutes(app);
  registerToolRoutes(app);

  // ---------- accounts ----------
  /**
   * Kèm lý do lỗi gần nhất cho account `failed`/`needs_human`.
   *
   * `setStatus()` chỉ lưu trạng thái, không lưu lý do — nên UI trước đây hiện "failed"
   * trơ trọi. Lý do vẫn còn trong bảng `runs`, chỉ cần nối lại: đo trên production có
   * 133 account `antigravity_no_code` (OAuth chờ 90s không bắt được authorization code).
   * Biết mã lỗi mới sửa được; thấy mỗi chữ "failed" thì không.
   */
  app.get('/api/accounts', async () => {
    const accounts = store.listAccounts();
    const errs = lastRunErrors();
    return {
      accounts: accounts.map((a) => {
        const fails: Record<string, string> = {};
        for (const flow of FLOW_KEYS) {
          const hit = errs.get(`${a.email}:${flow}`);
          if (hit) fails[flow] = hit.error;
        }
        return Object.keys(fails).length ? { ...a, lastErrors: fails } : a;
      }),
      /** Xếp hạng lý do — trả lời "sửa cái nào thì cứu được nhiều account nhất". */
      reasons: failureReasons(),
    };
  });

  app.post('/api/accounts', async (req, reply) => {
    const b = req.body as Partial<Account>;
    if (!b.email) return reply.code(400).send({ error: 'thiếu email' });
    const acc = store.upsertAccount({
      email: b.email,
      password: b.password ?? '',
      totp_secret: b.totp_secret ?? '',
      proxy: b.proxy ?? '',
      note: b.note ?? '',
    });
    return { account: acc };
  });

  // Import hàng loạt: mỗi dòng `email:password:totp:proxy` (totp/proxy optional)
  app.post('/api/accounts/import', async (req) => {
    const { text } = req.body as { text: string };
    let added = 0;
    for (const raw of (text ?? '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [email, password = '', totp = '', proxy = ''] = line.split(/[:,;\t]/).map((s) => s.trim());
      if (!email) continue;
      store.upsertAccount({ email, password, totp_secret: totp, proxy });
      added++;
    }
    return { added };
  });

  // Sinh nhanh dải account: prefix+start..end @domain, cùng password
  app.post('/api/accounts/generate', async (req) => {
    const b = req.body as {
      prefix: string;
      start: number;
      end: number;
      domain: string;
      password: string;
      extra?: string; // các email lẻ, phân tách dấu phẩy
    };
    let added = 0;
    const start = Number(b.start);
    const end = Number(b.end);
    for (let i = start; i <= end; i++) {
      const email = `${b.prefix}${i}@${b.domain}`;
      store.upsertAccount({ email, password: b.password ?? '' });
      added++;
    }
    for (const e of (b.extra ?? '').split(/[,\s]+/).filter(Boolean)) {
      const email = e.includes('@') ? e : `${e}@${b.domain}`;
      store.upsertAccount({ email, password: b.password ?? '' });
      added++;
    }
    return { added };
  });

  app.delete('/api/accounts/:email', async (req) => {
    const { email } = req.params as { email: string };
    store.deleteAccount(decodeURIComponent(email));
    return { ok: true };
  });

  app.post('/api/accounts/:email/proxy', async (req) => {
    const { email } = req.params as { email: string };
    const { proxy } = req.body as { proxy: string };
    store.upsertAccount({ email: decodeURIComponent(email), proxy });
    return { ok: true };
  });

  // Gán proxy round-robin cho account chưa có proxy (sticky: không đụng account đã gán)
  app.post('/api/accounts/auto-proxy', async (req) => {
    const { reassign } = (req.body ?? {}) as { reassign?: boolean };
    const proxies = store.listProxies();
    if (proxies.length === 0) return { assigned: 0, error: 'chưa có proxy' };
    let i = 0;
    let assigned = 0;
    for (const acc of store.listAccounts()) {
      if (acc.proxy && !reassign) continue;
      const p = proxies[i % proxies.length]!;
      store.upsertAccount({ email: acc.email, proxy: p.label });
      i++;
      assigned++;
    }
    return { assigned };
  });

  // ---------- proxies ----------
  app.get('/api/proxies', async () => ({ proxies: store.listProxies() }));

  app.post('/api/proxies/import', async (req) => {
    const { url, text, replace } = req.body as { url?: string; text?: string; replace?: boolean };
    let list: Proxy[] = [];
    if (url && url.trim()) list = await fetchWebshareList(url.trim());
    else if (text && text.trim()) list = parseProxyList(text);
    else return { added: 0, error: 'cần url hoặc text' };

    if (replace) store.replaceProxies(list);
    else for (const p of list) store.upsertProxy(p);
    return { added: list.length };
  });

  app.post('/api/proxies/test/:label', async (req) => {
    const { label } = req.params as { label: string };
    const p = store.getProxy(decodeURIComponent(label));
    if (!p) return { ok: false, error: 'không tìm thấy proxy' };
    const r = await testProxy(p);
    if (r.ok && r.country) {
      store.upsertProxy({ ...p, country: r.country });
    }
    return r;
  });

  app.delete('/api/proxies/:label', async (req) => {
    const { label } = req.params as { label: string };
    store.deleteProxy(decodeURIComponent(label));
    return { ok: true };
  });

  // ---------- run control ----------
  app.post('/api/run', async (req) => {
    const { email, flow, noProxy } = req.body as { email: string; flow: FlowKey; noProxy?: boolean };
    if (!FLOW_KEYS.includes(flow)) return { error: 'flow không hợp lệ' };
    void scheduler.runNow(email, flow, noProxy);
    return { queued: true };
  });

  // ĐÃ GỠ: `POST /api/run-pipeline` — 0 caller; UI dùng `/api/run` và `/api/auto-run`.

  /**
   * Chạy lại hàng loạt. `statuses` lọc theo trạng thái để không trộn các nhóm hỏng
   * khác bản chất — vd chỉ chạy lại `needs_human` (vướng captcha, account thường vẫn
   * tốt) mà không đụng `failed` (lỗi thật, chạy lại dễ lặp lại đúng lỗi đó).
   */
  app.post('/api/auto-run', async (req) => {
    const { flows, noProxy, statuses } = (req.body ?? {}) as {
      flows?: FlowKey[]; noProxy?: boolean; statuses?: string[];
    };
    const valid = (flows ?? []).filter((f) => FLOW_KEYS.includes(f));
    const st = (statuses ?? []).filter((s) => ['new', 'failed', 'needs_human', 'running'].includes(s));
    const n = scheduler.enqueueAuto(valid.length ? valid : undefined, noProxy, st.length ? st : undefined);
    return { queued: n, statuses: st.length ? st : 'tất cả trạng thái khác ok' };
  });

  app.post('/api/stop', async () => {
    scheduler.stop();
    return { ok: true };
  });

  app.get('/api/scheduler', async () => scheduler.status());

  // ---------- runs / logs / human ----------
  app.get('/api/runs', async () => ({ runs: recentRuns(80) }));
  app.get('/api/runs/:id/logs', async (req) => {
    const { id } = req.params as { id: string };
    return { logs: runLogs(Number(id)) };
  });
  app.post('/api/runs/:id/continue', async (req) => {
    const { id } = req.params as { id: string };
    return { ok: resumeHuman(Number(id)) };
  });
  app.post('/api/runs/:id/skip', async (req) => {
    const { id } = req.params as { id: string };
    return { ok: skipHuman(Number(id)) };
  });
  app.get('/api/pending-human', async () => ({ pending: pendingHumanRuns() }));

  /**
   * ĐÃ GỠ: `GET /api/summary` — `/api/overview` đã thay thế hoàn toàn (0 caller).
   *
   * Nó còn giữ hai trường `omniOk`/`connectionCount` cứng bằng 0/false "để client cũ đọc
   * không vỡ" — mà không còn client cũ nào. Phần `proxyLoad` đã có trong `/api/overview`.
   */

  // ---------- overview (gộp cho trang Tổng quan) ----------
  app.get('/api/overview', async () => {
    const accounts = store.listAccounts();
    const counts: Record<string, { ok: number; failed: number; needs_human: number; new: number; running: number }> = {};
    for (const f of PIPELINE) counts[f] = { ok: 0, failed: 0, needs_human: 0, new: 0, running: 0 };
    for (const a of accounts) for (const f of PIPELINE) {
      const st = a[`status_${f}` as keyof typeof a] as string;
      const b = counts[f]!; (b as any)[st] = ((b as any)[st] ?? 0) + 1;
    }
    // gateway pool
    const now = Date.now();
    const pl = pool.list();
    const gw = {
      total: pl.length,
      enabled: pl.filter((a) => a.enabled).length,
      cooldown: pl.filter((a) => (a.cooldownUntil || 0) > now).length,
      dead: pl.filter((a) => a.health === 'dead').length,
      requests: pl.reduce((s, a) => s + a.requests, 0),
      tokens: pl.reduce((s, a) => s + a.tokensIn + a.tokensOut, 0),
    };
    // quota tổng hợp
    const withQ = pl.filter((a) => a.quota);
    // Bỏ account KHÔNG có nhóm tương ứng thay vì tính 0% — nếu không, account chỉ có
    // nhóm Gemini sẽ kéo trung bình Claude xuống 0 và báo cạn nhầm.
    const gem = withQ.map((a) => geminiPct(a)).filter((x): x is number => x != null);
    const tp = withQ
      .map((a) => a.quota?.groups?.find((g) => !/gemini/i.test(g.name))?.pct)
      .filter((x): x is number => x != null);
    const avg = (arr: number[]) => (arr.length ? Math.round(arr.reduce((x, y) => x + y, 0) / arr.length) : null);
    // Giờ reset + tier của từng bể (lấy account mới nạp nhất — mọi account cùng tier thì như nhau)
    const bucketMeta = (isGem: boolean) => {
      for (const a of withQ) {
        const g = a.quota?.groups?.find((x) => isGem === /gemini/i.test(x.name));
        if (g?.resetTime) return { reset: g.resetTime, name: g.name };
      }
      return null;
    };
    const tierName = withQ.find((a) => a.quota?.tier)?.quota?.tier ?? null;
    /**
     * ĐỘ TƯƠI của dữ liệu quota — thiết bị đo, không phải trang trí.
     *
     * Sự cố 12/08/2026 ẩn được 28 giờ vì màn hình hiện số quota rất đẹp mà không nói nó
     * được đo khi nào. Engine chọn account bằng đúng những con số cũ đó.
     */
    const quotaAge = tuoiQuota(pl, now);
    // usage 7 ngày
    const to = now, from = to - 7 * 86400_000;
    const usage = { totals: usageTotals(from, to), series: usageSeries(from, to, 'day'), byModel: usageByModel(from, to).slice(0, 6), byAccount: usageByAccount(from, to).slice(0, 6) };
    // thống kê TÁCH THEO PROVIDER (agy có quota thật, kr chỉ có kết quả dò)
    const byProv = usageByProvider(from, to);
    const providers = PROVIDER_IDS.map((pid) => {
      const list = pool.list(pid);
      const q = list.filter((a) => a.quota).map((a) => geminiPct(a) ?? 0);
      const u = byProv.find((x) => x.provider === pid);
      return {
        id: pid,
        label: PROVIDERS[pid].label,
        total: list.length,
        enabled: list.filter((a) => a.enabled).length,
        ready: list.filter((a) => a.enabled && a.health !== 'dead' && (a.cooldownUntil || 0) <= now).length,
        cooldown: list.filter((a) => (a.cooldownUntil || 0) > now).length,
        quotaAvg: q.length ? Math.round(q.reduce((x, y) => x + y, 0) / q.length) : null,
        probeOk: list.filter((a) => a.liveStatus === 'ok').length,
        requests: u?.requests ?? 0,
        tokens: (u?.tokIn ?? 0) + (u?.tokOut ?? 0),
        estimated: pid === 'kr', // Kiro không trả usage → token là ước lượng
      };
    });
    // Phân bố account trên mỗi IP — nhiều account chung 1 IP dễ kéo checkpoint chain
    // (xem docs/DECISIONS.md §5).
    const proxyLoad: Record<string, number> = {};
    for (const a of accounts) {
      const k = a.proxy || '(direct)';
      proxyLoad[k] = (proxyLoad[k] ?? 0) + 1;
    }
    return {
      accounts: { total: accounts.length, counts },
      proxies: store.listProxies().length,
      proxyLoad,
      gateway: gw,
      providers,
      quota: {
        fetched: withQ.length,
        quotaAge,
        geminiAvg: avg(gem),
        thirdPartyAvg: avg(tp),
        tier: tierName,
        geminiReset: bucketMeta(true)?.reset ?? null,
        thirdPartyReset: bucketMeta(false)?.reset ?? null,
      },
      usage,
      sched: scheduler.status(),
    };
  });

  // ---------- CẤU HÌNH TỔNG (mọi trường, lưu DB) ----------
  app.get('/api/settings', async () => {
    const values: Record<string, unknown> = {};
    for (const k of CONFIG_KEYS) {
      const v = getConfigValue(k);
      // Secret: không trả giá trị thật, chỉ báo có hay không
      values[k] = SECRET_KEYS.has(k) ? (v ? '••••••••' : '') : v;
    }
    return {
      values,
      secretKeys: [...SECRET_KEYS],
      restartKeys: [...RESTART_KEYS],
      meta: { dataDir: AGY_HOME, version: pkgVersion(), baseUrl: `http://localhost:${config.port}/proxy/v1` },
    };
  });

  app.patch('/api/settings', async (req) => {
    const patch = (req.body as Record<string, unknown>) ?? {};
    // Bỏ qua secret gửi lên dạng che (người dùng không sửa)
    for (const k of Object.keys(patch)) {
      if (SECRET_KEYS.has(k) && patch[k] === '••••••••') delete patch[k];
      if (k === 'dashboardPassword') delete patch[k]; // đổi mật khẩu qua endpoint riêng
    }
    const { changed, rejected } = applyConfig(patch);
    // Áp nóng những thứ cần
    if (changed.includes('tokenHealthHours')) restartHealthLoop(config.tokenHealthHours);
    const needRestart = changed.filter((k) => RESTART_KEYS.has(k));
    // `rejected` cho biết khoá nào bị từ chối và VÌ SAO — trước đây bỏ qua im lặng nên
    // người dùng nhập giá trị sai vẫn nhận "ok: true" và tưởng đã lưu.
    return { ok: true, changed, rejected, needRestart };
  });


  // ---------- cập nhật bản mới ----------
  // Có sẵn CLI `agyproxy update` nhưng phải SSH vào máy chủ mới chạy được; hai endpoint
  // này đưa đúng luồng đó lên dashboard.
  app.get('/api/system/update', async () => checkUpdate());

  app.post('/api/system/update', async (req, reply) => {
    const b = (req.body as { restart?: boolean; force?: boolean }) ?? {};
    const info = await checkUpdate();
    if (!info.canSelfUpdate) {
      return reply.code(400).send({ ok: false, error: 'Bản cài không phải git checkout — cập nhật bằng `agyproxy update` trên máy chủ', steps: [] });
    }
    /**
     * `force` để chạy được cả khi KHÔNG phát hiện ra bản mới.
     *
     * Cần vì `hasUpdate` phụ thuộc GitHub API: hết hạn ngạch (60 lượt/giờ theo IP, không
     * token) hoặc mất mạng là `remoteSha` null → `coBanMoi` trả false cho an toàn. Khi đó
     * `git pull --ff-only` vẫn là thao tác vô hại nếu đã ở bản mới nhất.
     */
    if (!info.hasUpdate && !b.force) {
      return { ok: true, upToDate: true, ...info, steps: [] };
    }
    const steps = await runUpdate();
    const ok = steps.every((s) => s.ok);
    // Restart TÁCH RIÊNG và luôn chậm nhịp: trả response xong mới thoát, nếu không client
    // mất kết nối trước khi biết cập nhật thành công hay thất bại.
    if (ok && b.restart !== false) {
      setTimeout(() => process.exit(0), 1500);
    }
    return { ok, steps, restarting: ok && b.restart !== false, ...(await checkUpdate()) };
  });

  // Khởi động lại (service/CLI sẽ dựng lại tiến trình)
  app.post('/api/system/restart', async (_req, reply) => {
    reply.send({ ok: true, message: 'Đang khởi động lại…' });
    setTimeout(() => process.exit(0), 300);
  });

  // ---------- bảo mật: đổi user/mật khẩu dashboard ----------
  app.get('/api/security', async () => ({
    hasPassword: !!config.dashboardPassword,
    isDefault: verifyPassword('123456', config.dashboardPassword),
    user: config.dashboardUser,
    host: config.host,
    open: config.host === '0.0.0.0' || config.host === '::',
    /** `false` = đang mở khoá (không hỏi mật khẩu), nhưng mật khẩu VẪN còn trong DB. */
    locked: !config.authDisabled,
    /** Mật khẩu đã đặt là passcode 6 số hay mật khẩu chữ. */
    isPasscode: config.passcodeMode,
  }));

  /**
   * Khoá / mở khoá đăng nhập dashboard mà KHÔNG đụng tới mật khẩu đã lưu.
   *
   * Vì sao không dùng cách xoá mật khẩu (`POST /api/security/password` với chuỗi rỗng):
   * mật khẩu lưu dạng scrypt hash không đảo ngược được, xoá là mất vĩnh viễn — khoá lại
   * sẽ phải nghĩ và gõ passcode mới. Cờ riêng cho phép bật/tắt qua lại không mất gì.
   *
   * Mở khoá BẮT BUỘC nhập mật khẩu hiện tại: nếu không, bất kỳ ai đã vào được dashboard
   * (kể cả qua phiên còn hạn của người khác) đều tắt được đăng nhập cho mọi lần sau.
   * Khoá lại thì không cần — siết chặt luôn là an toàn.
   */
  app.post('/api/security/lock', async (req, reply) => {
    const b = (req.body as { locked?: boolean; current?: string }) ?? {};
    const locked = b.locked !== false;

    if (!config.dashboardPassword) {
      return reply.code(400).send({ ok: false, error: 'Chưa đặt mật khẩu — không có gì để khoá' });
    }
    if (!locked && !verifyPassword(b.current ?? '', config.dashboardPassword)) {
      return reply.code(403).send({ ok: false, error: 'Mật khẩu hiện tại không đúng' });
    }

    const v = locked ? '' : '1';
    config.authDisabled = !locked;
    saveSettings({ authDisabled: v });
    return { ok: true, locked };
  });

  app.post('/api/security/password', async (req, reply) => {
    const b = (req.body as { password?: string; user?: string; current?: string }) ?? {};
    // Đã có mật khẩu → phải nhập đúng mật khẩu hiện tại (timing-safe, hỗ trợ hash).
    if (config.dashboardPassword && !verifyPassword(b.current ?? '', config.dashboardPassword)) {
      return reply.code(403).send({ ok: false, error: 'Mật khẩu hiện tại không đúng' });
    }
    const pass = (b.password ?? '').trim();
    const user = (b.user ?? '').trim();
    if (pass && pass.length < 6) {
      return reply.code(400).send({ ok: false, error: 'Mật khẩu tối thiểu 6 ký tự' });
    }
    // Passcode 6 số chỉ có 10^6 tổ hợp nên phải chặn các mã dễ đoán nhất — 000000,
    // 123456… là thứ người dò thử ĐẦU TIÊN, và chúng lọt qua "tối thiểu 6 ký tự".
    if (isWeakPasscode(pass)) {
      return reply.code(400).send({ ok: false, error: 'Passcode quá dễ đoán (số lặp lại hoặc dãy liên tiếp) — chọn mã khác' });
    }
    const stored = pass ? hashPassword(pass) : ''; // lưu HASH, không lưu plaintext
    config.dashboardPassword = stored;
    config.dashboardUser = user;
    // Hash scrypt không suy ngược được, nên "đây là passcode hay mật khẩu chữ" phải ghi
    // riêng ngay lúc đặt — sau này không còn cách nào biết.
    const pcMode = pass && isPasscode(pass) ? '1' : '';
    config.passcodeMode = pcMode === '1';
    // Đặt mật khẩu mới thì luôn về trạng thái KHOÁ: vừa đặt xong mà vẫn mở là bất ngờ.
    config.authDisabled = false;
    saveSettings({ dashboardPassword: stored, dashboardUser: user, passcodeMode: pcMode, authDisabled: '' });
    return { ok: true, hasPassword: !!pass, user, isPasscode: config.passcodeMode };
  });

  // ---------- backup / restore toàn bộ (JSON kèm token) ----------
  app.get('/api/backup/export', async (req, reply) => {
    // ?history=1 để kèm usage/quota/runs. Mặc định không: quota_history một mình
    // chiếm ~71% dung lượng file mà chỉ dùng vẽ biểu đồ xu hướng.
    const withHistory = (req.query as any)?.history === '1';
    const data = buildBackup({ history: withHistory });
    const date = new Date().toISOString().slice(0, 10);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="antigravity-backup_${date}.json"`);
    return data;
  });

  app.post('/api/backup/import', async (req, reply) => {
    const b = req.body as { data?: any; mode?: 'merge' | 'replace' };
    const data = b?.data ?? b; // chấp nhận cả {data,mode} lẫn object thuần
    try {
      const r = restoreBackup(data, { mode: b?.mode });
      return { ok: true, ...r };
    } catch (e: any) {
      return reply.code(400).send({ ok: false, error: e?.message ?? String(e) });
    }
  });


  // ---------- credentials ----------
  /**
   * ĐÃ GỠ: `GET/PATCH /api/config` — đường ghi cấu hình thứ BA, 0 caller ở web, CLI, MCP.
   *
   * Nó dịch tay 5 trường (`pacingMinSec`, `dailyCap`…) thay vì đi qua `applyConfig()`, nên
   * không có validate lẫn `rejected`. Hai đường còn lại là đủ và đều dùng `applyConfig`:
   *   · `PATCH /api/settings`       — CLI (`agyproxy model --big/--small`)
   *   · `PATCH /api/gateway/config` — dashboard
   */

  app.get('/api/credentials', async () => ({ credentials: store.listCredentials() }));

  // Kiểm token health (tất cả hoặc lọc theo target agy/kiro).
  app.post('/api/tokens/check', async (req) => {
    const { target } = (req.body ?? {}) as { target?: string };
    const stats = await checkAll(target);
    return { ok: true, ...stats };
  });

  /**
   * ĐÃ GỠ: `/api/export/{antigravity,kiro,accounts}`.
   *
   * Không trang nào, CLI nào, MCP nào gọi (grep 0 hit ở cả bốn nơi). Và chúng trả
   * **refresh token nguyên văn** của cả pool — xoá vừa dọn code vừa bớt một đường rò.
   * Muốn sao lưu thì dùng `/api/backup/export` (CLI đang dùng, có đủ ngữ cảnh khôi phục).
   */

  // Retry: xếp lại các flow đã chọn cho account đang failed/needs_human.
  app.post('/api/retry-failed', async (req) => {
    const { flows, noProxy } = (req.body ?? {}) as { flows?: FlowKey[]; noProxy?: boolean };
    const use = (flows ?? []).filter((f) => FLOW_KEYS.includes(f));
    const list = use.length ? use : PIPELINE;
    let queued = 0;
    for (const a of store.listAccounts()) {
      for (const f of list) {
        const st = a[`status_${f}` as keyof typeof a] as string;
        if (st === 'failed' || st === 'needs_human') {
          scheduler.runNow(a.email, f, noProxy);
          queued++;
        }
      }
    }
    return { queued };
  });

  // Health check: trạng thái tổng quan các provider + pool
  app.get('/api/health', async () => {
    const all = store.listAccounts();
    const byProv: Record<string, { total: number; ok: number; failed: number; needsHuman: number }> = {};
    const inc = (p: string, k: 'total' | 'ok' | 'failed' | 'needsHuman') => {
      byProv[p] ??= { total: 0, ok: 0, failed: 0, needsHuman: 0 };
      byProv[p][k]++;
    };
    for (const a of all) {
      for (const prov of ['agy', 'kiro', 'google', 'gweb', 'gcli'] as const) {
        const st = a[`status_${prov}` as keyof Account] as TargetStatus | undefined;
        if (!st || st === 'new') continue;
        const label = prov === 'agy' ? 'antigravity' : prov === 'kiro' ? 'kiro' : prov;
        inc(label, 'total');
        if (st === 'ok') inc(label, 'ok');
        else if (st === 'failed') inc(label, 'failed');
        else if (st === 'needs_human') inc(label, 'needsHuman');
      }
    }
    const poolAccs = pool.list();
    return {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      version: pkgVersion(),
      accounts: all.length,
      poolSize: poolAccs.length,
      providers: Object.entries(byProv).map(([id, s]) => ({ id, ...s })),
    };
  });
}
