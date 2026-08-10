import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { SCREENSHOTS_DIR, config } from '../config.js';
import { createRun, updateRun, addLog, type RunRow, getRun } from '../store/db.js';
import { emitLog, emitRun } from '../events.js';
import { store } from '../store/index.js';
import type { Account, FlowKey, Proxy } from '../store/models.js';
import { openProfile, type Session } from '../browser/profile.js';
import { detectChallenge } from '../browser/challenge.js';

/**
 * Máy này có mở được cửa sổ trình duyệt không?
 *
 * macOS/Windows luôn có. Linux phải có X hoặc Wayland, và Chrome nhận biết qua BIẾN
 * MÔI TRƯỜNG `DISPLAY`/`WAYLAND_DISPLAY` — có socket ở /tmp/.X11-unix mà thiếu biến
 * thì vẫn chết, nên không kiểm socket làm gì.
 *
 * Server Debian chạy agyproxy không có cái nào. Đo thật từ log production:
 * "Missing X server or $DISPLAY" → "The platform failed to initialize. Exiting."
 */
function canOpenWindow(): boolean {
  if (process.platform !== 'linux') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Đăng ký các run đang chờ người bấm tay. */
interface HumanWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  reason: string;
  since: number;
}
const humanWaiters = new Map<number, HumanWaiter>();

export function resumeHuman(runId: number): boolean {
  const w = humanWaiters.get(runId);
  if (!w) return false;
  humanWaiters.delete(runId);
  w.resolve();
  return true;
}
export function skipHuman(runId: number): boolean {
  const w = humanWaiters.get(runId);
  if (!w) return false;
  humanWaiters.delete(runId);
  w.reject(new Error('skipped_by_user'));
  return true;
}
export function pendingHumanRuns(): { runId: number; reason: string; since: number }[] {
  return [...humanWaiters.entries()].map(([runId, w]) => ({
    runId,
    reason: w.reason,
    since: w.since,
  }));
}

export class RunContext {
  constructor(
    public runId: number,
    public account: Account,
    public flow: FlowKey,
    public session: Session,
    public headless: boolean = false,
  ) {}

  get page(): Page {
    return this.session.page;
  }

  log(msg: string, level: 'info' | 'warn' | 'error' | 'challenge' = 'info', screenshot?: string): void {
    addLog(this.runId, level, msg, screenshot);
    emitLog({
      runId: this.runId,
      email: this.account.email,
      flow: this.flow,
      level,
      msg,
      screenshot,
    });
  }

  async screenshot(tag: string): Promise<string> {
    const name = `${this.account.profile_dir}_${this.flow}_${tag}_${this.runId}.png`;
    const path = resolve(SCREENSHOTS_DIR, name);
    try {
      await this.page.screenshot({ path, fullPage: false });
    } catch {
      /* trang có thể đã đóng */
    }
    return `/screenshots/${name}`;
  }

  /** Kiểm tra challenge; nếu có, pause chờ người xử lý tay. Ném lỗi nếu skip/timeout. */
  async guardChallenge(): Promise<void> {
    const hit = await detectChallenge(this.page);
    if (!hit) return;
    const shot = await this.screenshot(`challenge_${hit.kind}`);
    // Ở headless không có cửa sổ để bấm tay -> báo để runFlow mở lại headful.
    if (this.headless) {
      this.log(`Challenge (${hit.kind}) khi headless — mở lại cửa sổ để xử lý tay`, 'challenge', shot);
      throw new Error('challenge_in_headless');
    }
    this.log(`Challenge: ${hit.kind} (${hit.detail}) — cần xử lý tay`, 'challenge', shot);
    await this.waitForHuman(`${hit.kind}: ${hit.detail}`);
    // sau khi người xử lý xong, cho trang ổn định lại
    await this.page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  }

  /** Chuyển run sang paused_needs_human, chờ dashboard resume/skip hoặc timeout. */
  waitForHuman(reason: string): Promise<void> {
    updateRun(this.runId, 'paused_needs_human');
    store.setStatus(this.account.email, this.flow, 'needs_human');
    emitRun({
      runId: this.runId,
      email: this.account.email,
      flow: this.flow,
      status: 'paused_needs_human',
      detail: reason,
    });
    return new Promise<void>((res, rej) => {
      const timeoutMs = config.humanTimeoutSec * 1000;
      const timer = setTimeout(() => {
        humanWaiters.delete(this.runId);
        rej(new Error('human_timeout'));
      }, timeoutMs);
      humanWaiters.set(this.runId, {
        reason,
        since: Date.now(),
        resolve: () => {
          clearTimeout(timer);
          updateRun(this.runId, 'running');
          emitRun({
            runId: this.runId,
            email: this.account.email,
            flow: this.flow,
            status: 'running',
            detail: 'resumed',
          });
          res();
        },
        reject: (e) => {
          clearTimeout(timer);
          rej(e);
        },
      });
    });
  }
}

export type FlowFn = (ctx: RunContext) => Promise<void>;

/**
 * Bọc 1 flow: tạo run, mở profile (proxy sticky), chạy, cập nhật trạng thái + CSV.
 * KHÔNG retry — fail 1 lần thì dừng (RULES mục D).
 */
export async function runFlow(
  email: string,
  flow: FlowKey,
  fn: FlowFn,
  opts?: { noProxy?: boolean },
): Promise<RunRow> {
  const account = store.getAccount(email);
  if (!account) throw new Error(`Account không tồn tại: ${email}`);
  const proxy: Proxy | undefined =
    opts?.noProxy || !account.proxy ? undefined : store.getProxy(account.proxy);
  const proxyLabel = proxy ? proxy.label : 'direct';

  const runId = createRun(email, flow, proxyLabel);
  store.setStatus(email, flow, 'running');
  emitRun({ runId, email, flow, status: 'running' });

  // 1 lần chạy với 1 chế độ headless nhất định.
  const attempt = async (headless: boolean): Promise<void> => {
    let session: Session | undefined;
    try {
      session = await openProfile(account, proxy, headless);
      const ctx = new RunContext(runId, account, flow, session, headless);
      ctx.log(`Bắt đầu flow ${flow} — proxy ${proxyLabel} — headless=${headless}`);
      await fn(ctx);
    } finally {
      if (session) await session.close();
    }
  };

  try {
    try {
      await attempt(config.headless);
    } catch (e) {
      // Gặp challenge khi headless -> mở lại cửa sổ headful để người xử lý tay.
      if (config.headless && e instanceof Error && e.message === 'challenge_in_headless') {
        /**
         * Chỉ mở được cửa sổ khi máy CÓ màn hình.
         *
         * Server Debian không chạy X, nên `attempt(false)` chết ngay với
         * "Missing X server or $DISPLAY" — một lỗi Playwright dài 30 dòng chôn vùi
         * nguyên nhân thật (captcha cần người xử lý). Người vận hành đọc log chỉ thấy
         * "browser has been closed" và tưởng trình duyệt hỏng.
         *
         * Không có màn hình thì dừng ở `needs_human` — đúng bản chất: việc này CẦN
         * người, và người phải làm ở nơi có màn hình.
         */
        if (!canOpenWindow()) {
          addLog(runId, 'challenge', 'Cần người xử lý captcha, nhưng máy chủ không có màn hình (X server). Xử lý trên máy có giao diện, hoặc cài xvfb.');
          throw new Error('challenge_no_display');
        }
        emitRun({ runId, email, flow, status: 'running', detail: 'escalate: mở cửa sổ để xử lý challenge' });
        await attempt(false);
      } else {
        throw e;
      }
    }
    updateRun(runId, 'ok');
    store.setStatus(email, flow, 'ok');
    emitRun({ runId, email, flow, status: 'ok' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateRun(runId, 'failed', msg);
    // `challenge_no_display`: máy chủ không có màn hình nên KHÔNG mở được cửa sổ cho
    // người xử lý captcha. Vẫn là 'needs_human' — cần người, chỉ là phải làm nơi khác —
    // chứ không phải 'failed' (account có thể vẫn tốt nguyên).
    const canHuman = msg === 'human_timeout' || msg === 'skipped_by_user' || msg === 'challenge_no_display';
    store.setStatus(email, flow, canHuman ? 'needs_human' : 'failed');
    addLog(runId, 'error', msg);
    emitLog({ runId, email, flow, level: 'error', msg });
    emitRun({ runId, email, flow, status: 'failed', detail: msg });
  } finally {
    humanWaiters.delete(runId);
  }
  return getRun(runId)!;
}
