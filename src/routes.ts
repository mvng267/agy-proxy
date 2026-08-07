import type { FastifyInstance } from 'fastify';
import { store } from './store/index.js';
import type { Account, FlowKey, Proxy, TargetStatus } from './store/models.js';
import { FLOW_KEYS } from './store/models.js';
import { scheduler } from './queue/scheduler.js';
import { runSingle, PIPELINE } from './flows/index.js';
import { resumeHuman, skipHuman, pendingHumanRuns } from './flows/runner.js';
import { recentRuns, runLogs } from './store/db.js';
import { fetchWebshareList, parseProxyList, testProxy } from './proxy/webshare.js';
import { omniroute } from './omniroute/client.js';
import { config, CSV, saveSettings, setConfig, applyConfig, getConfigValue, CONFIG_KEYS, SECRET_KEYS, RESTART_KEYS, AGY_HOME, ROOT } from './config.js';
import { checkAll, restartHealthLoop } from './health/tokenHealth.js';
import { hashPassword, verifyPassword } from './security.js';
import { registerGatewayRoutes } from './gateway/routes.js';
import { registerToolRoutes } from './tools/routes.js';
import { buildBackup, restoreBackup } from './backup.js';
import { pool, geminiPct } from './gateway/pool.js';
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
  app.get('/api/accounts', async () => ({ accounts: store.listAccounts() }));

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

  app.post('/api/run-pipeline', async (req) => {
    const { email, flows } = req.body as { email: string; flows?: FlowKey[] };
    scheduler.enqueuePipeline(email, flows ?? PIPELINE);
    return { queued: true };
  });

  app.post('/api/auto-run', async (req) => {
    const { flows, noProxy } = (req.body ?? {}) as { flows?: FlowKey[]; noProxy?: boolean };
    const valid = (flows ?? []).filter((f) => FLOW_KEYS.includes(f));
    const n = scheduler.enqueueAuto(valid.length ? valid : undefined, noProxy);
    return { queued: n };
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

  // ---------- summary (stats) ----------
  app.get('/api/summary', async () => {
    const accounts = store.listAccounts();
    const counts: Record<string, Record<string, number>> = {};
    for (const f of PIPELINE) counts[f] = { ok: 0, failed: 0, needs_human: 0, new: 0, running: 0 };
    for (const a of accounts) {
      for (const f of PIPELINE) {
        const st = a[`status_${f}` as keyof typeof a] as string;
        const bucket = counts[f]!;
        bucket[st] = (bucket[st] ?? 0) + 1;
      }
    }
    let connectionCount = 0;
    let omniOk = false;
    try {
      connectionCount = (await omniroute.listConnections()).length;
      omniOk = true;
    } catch {
      /* offline */
    }
    // Số account/mỗi proxy (IP) — cảnh báo checkpoint chain nếu quá đông.
    const proxyLoad: Record<string, number> = {};
    for (const a of accounts) {
      const key = a.proxy || '(direct)';
      proxyLoad[key] = (proxyLoad[key] ?? 0) + 1;
    }
    const maxPerProxy = Math.max(0, ...Object.values(proxyLoad));
    // health tổng hợp
    const creds = store.listCredentials();
    const health = {
      alive: creds.filter((c) => c.health === 'alive').length,
      dead: creds.filter((c) => c.health === 'dead').length,
    };
    return {
      totalAccounts: accounts.length,
      totalProxies: store.listProxies().length,
      flows: PIPELINE,
      counts,
      omniOk,
      connectionCount,
      proxyLoad,
      maxPerProxy,
      health,
      dailyCap: config.dailyLoginCap,
      sched: scheduler.status(),
    };
  });

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
    let omniOk = false; try { await omniroute.listConnections(); omniOk = true; } catch { /* offline */ }
    // Phân bố account trên mỗi IP — nhiều account chung 1 IP dễ kéo checkpoint chain
    // (xem docs/DECISIONS.md §5). Trước đây chỉ /api/summary có, Tổng quan không vẽ được.
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
        geminiAvg: avg(gem),
        thirdPartyAvg: avg(tp),
        tier: tierName,
        geminiReset: bucketMeta(true)?.reset ?? null,
        thirdPartyReset: bucketMeta(false)?.reset ?? null,
      },
      usage,
      sched: scheduler.status(),
      omniOk,
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
    if (changed.includes('omnirouteUrl') || changed.includes('omniroutePassword')) omniroute.reset();
    if (changed.includes('tokenHealthHours')) restartHealthLoop(config.tokenHealthHours);
    const needRestart = changed.filter((k) => RESTART_KEYS.has(k));
    // `rejected` cho biết khoá nào bị từ chối và VÌ SAO — trước đây bỏ qua im lặng nên
    // người dùng nhập giá trị sai vẫn nhận "ok: true" và tưởng đã lưu.
    return { ok: true, changed, rejected, needRestart };
  });

  // Test/đăng nhập OmniRoute ngay trong Cấu hình
  app.post('/api/settings/omniroute/test', async () => {
    omniroute.reset();
    try {
      const conns = await omniroute.listConnections();
      return { ok: true, connections: conns.length };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
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
  }));

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
    const stored = pass ? hashPassword(pass) : ''; // lưu HASH, không lưu plaintext
    config.dashboardPassword = stored;
    config.dashboardUser = user;
    saveSettings({ dashboardPassword: stored, dashboardUser: user });
    return { ok: true, hasPassword: !!pass, user };
  });

  // ---------- backup / restore toàn bộ (JSON kèm token) ----------
  app.get('/api/backup/export', async (_req, reply) => {
    const data = buildBackup();
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

  // ---------- omniroute ----------
  app.get('/api/omniroute/connections', async () => {
    try {
      const connections = await omniroute.listConnections();
      return { ok: true, connections };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  app.get('/api/omniroute/models', async () => {
    try {
      return { ok: true, models: await omniroute.listModels() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  app.post('/api/omniroute/chat', async (req) => {
    const { model, content } = req.body as { model: string; content: string };
    if (!model) return { ok: false, error: 'thiếu model' };
    return omniroute.chat(model, content || 'Say hi in 3 words.');
  });

  // ---------- config / credentials ----------
  app.get('/api/config', async () => ({
    omnirouteUrl: config.omniroute.url,
    pacing: config.pacing,
    dailyCap: config.dailyLoginCap,
    headless: config.headless,
    fingerprint: config.fingerprint,
    chromeMajor: config.chromeMajor,
    tokenHealthHours: config.tokenHealthHours,
    flows: PIPELINE,
  }));

  // Cập nhật config runtime (pacing / cap / headless). Không ghi .env.
  app.patch('/api/config', async (req) => {
    const b = req.body as {
      pacingMinSec?: number;
      pacingMaxSec?: number;
      dailyCap?: number;
      headless?: boolean;
      fingerprint?: boolean;
    };
    // Tương thích ngược — nay GHI DB qua setConfig để sống qua restart.
    const patch: Record<string, unknown> = {};
    if (typeof b.pacingMinSec === 'number') patch.pacingMinSec = Math.max(0, b.pacingMinSec);
    if (typeof b.pacingMaxSec === 'number') patch.pacingMaxSec = Math.max(0, b.pacingMaxSec);
    if (typeof b.dailyCap === 'number') patch.dailyLoginCap = Math.max(0, b.dailyCap);
    if (typeof b.headless === 'boolean') patch.headless = b.headless;
    if (typeof b.fingerprint === 'boolean') patch.fingerprint = b.fingerprint;
    setConfig(patch);
    return {
      ok: true,
      pacing: config.pacing,
      dailyCap: config.dailyLoginCap,
      headless: config.headless,
      fingerprint: config.fingerprint,
    };
  });

  app.get('/api/credentials', async () => ({ credentials: store.listCredentials() }));

  // Kiểm token health (tất cả hoặc lọc theo target agy/kiro).
  app.post('/api/tokens/check', async (req) => {
    const { target } = (req.body ?? {}) as { target?: string };
    const stats = await checkAll(target);
    return { ok: true, ...stats };
  });

  // Export cho "antigravity manager": [{ email, refresh_token }] — chỉ account đã có refresh_token thật.
  app.get('/api/export/antigravity', async (_req, reply) => {
    const rows = store
      .listCredentials()
      .filter((c) => c.target === 'agy' && c.value.startsWith('1//'))
      .map((c) => ({ email: c.email, refresh_token: c.value }));
    const date = new Date().toISOString().slice(0, 10);
    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="antigravity_accounts_${date}.json"`);
    return rows;
  });

  // Export Kiro: [{ email, refresh_token }] từ credential kiro (value JSON).
  app.get('/api/export/kiro', async (_req, reply) => {
    const rows = store
      .listCredentials()
      .filter((c) => c.target === 'kiro')
      .map((c) => {
        let rt = c.value;
        try {
          rt = (JSON.parse(c.value) as { refreshToken?: string }).refreshToken ?? c.value;
        } catch {
          /* value thô */
        }
        return { email: c.email, refresh_token: rt };
      })
      .filter((r) => r.refresh_token);
    const date = new Date().toISOString().slice(0, 10);
    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="kiro_accounts_${date}.json"`);
    return rows;
  });

  // Export accounts.csv (backup).
  app.get('/api/export/accounts', async (_req, reply) => {
    const csv = readFileSync(CSV.accounts, 'utf8');
    const date = new Date().toISOString().slice(0, 10);
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="accounts_${date}.csv"`);
    return csv;
  });

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
