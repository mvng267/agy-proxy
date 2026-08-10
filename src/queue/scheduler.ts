import { config } from '../config.js';
import { store } from '../store/index.js';
import type { FlowKey } from '../store/models.js';
import { runSingle, PIPELINE } from '../flows/index.js';
import { loginsLast24h, loginsLast24hByProxy } from '../store/db.js';
import { emitRun } from '../events.js';
import { rand, sleep } from '../browser/human.js';

const LOGIN_FLOWS: FlowKey[] = ['google', 'agy', 'kiro'];

/**
 * Scheduler: đảm bảo CHỈ 1 browser chạy tại một thời điểm (tuần tự tuyệt đối),
 * giãn nhịp ngẫu nhiên giữa các account, và tôn trọng cap login/ngày (RULES D).
 */

type Job = { email: string; flow: FlowKey; noProxy?: boolean };

class Scheduler {
  private queue: Job[] = [];
  private running = false;
  private current: Job | null = null;
  private stopRequested = false;
  // Theo dõi tiến độ/ETA của "đợt" chạy hiện tại.
  private batchTotal = 0;
  private done = 0;
  private durations: number[] = []; // ms mỗi job (giữ 20 gần nhất) để ước tính

  status() {
    const avg = this.durations.length
      ? this.durations.reduce((a, b) => a + b, 0) / this.durations.length
      : 0;
    const remaining = this.queue.length + (this.running && this.current ? 1 : 0);
    const etaSec = avg ? Math.round((remaining * avg) / 1000) : 0;
    return {
      running: this.running,
      current: this.current,
      queued: this.queue.length,
      queue: this.queue.slice(0, 50),
      loginsLast24h: loginsLast24h(),
      dailyCap: config.dailyLoginCap,
      batchTotal: this.batchTotal,
      done: this.done,
      etaSec,
    };
  }

  /** Chạy 1 job đơn lẻ NGAY (vẫn tôn trọng khoá tuần tự). */
  async runNow(email: string, flow: FlowKey, noProxy?: boolean) {
    this.enqueue([{ email, flow, noProxy }]);
  }

  /** Xếp cả pipeline cho 1 account. */
  enqueuePipeline(email: string, flows: FlowKey[] = PIPELINE) {
    this.enqueue(flows.map((flow) => ({ email, flow })));
  }

  /** Auto Run: mọi account có target chưa 'ok' -> xếp các flow còn thiếu. */
  /**
   * Xếp hàng chạy lại account CHƯA `ok`.
   *
   * `statuses` lọc theo trạng thái cụ thể — cần vì các nhóm hỏng có bản chất khác nhau
   * và không nên chạy chung:
   *   needs_human  chỉ vướng captcha, account thường vẫn tốt → chạy lại là cứu được
   *   failed       lỗi thật (mạng đứt, OAuth hỏng) → chạy lại có thể lặp lại đúng lỗi
   *   new          chưa từng đăng nhập
   * Bỏ trống = mọi trạng thái khác `ok`, giữ nguyên hành vi cũ.
   */
  enqueueAuto(flows: FlowKey[] = PIPELINE, noProxy?: boolean, statuses?: string[]) {
    const use = flows.length ? flows : PIPELINE;
    const only = statuses?.length ? new Set(statuses) : null;
    const jobs: Job[] = [];
    for (const acc of store.listAccounts()) {
      for (const flow of use) {
        const st = (acc[`status_${flow}` as keyof typeof acc] as string) || 'new';
        if (st === 'ok') continue;
        if (only && !only.has(st)) continue;
        jobs.push({ email: acc.email, flow, noProxy });
      }
    }
    this.enqueue(jobs);
    return jobs.length;
  }

  enqueue(jobs: Job[]) {
    // Bắt đầu đợt mới nếu đang rảnh -> reset bộ đếm tiến độ.
    if (!this.running && this.queue.length === 0) {
      this.batchTotal = 0;
      this.done = 0;
    }
    this.queue.push(...jobs);
    this.batchTotal += jobs.length;
    void this.pump();
  }

  stop() {
    this.stopRequested = true;
    this.queue = [];
    this.batchTotal = 0;
    this.done = 0;
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    try {
      let first = true;
      while (this.queue.length > 0) {
        if (this.stopRequested) break;
        const job = this.queue.shift()!;
        this.current = job;

        // Cap login/24h THEO TỪNG IP: áp cho mọi flow có đăng nhập (agy/kiro/google).
        // Tính proxy của account (hoặc 'direct' khi noProxy) rồi đếm login/24h của IP đó.
        if (LOGIN_FLOWS.includes(job.flow)) {
          const acc = store.getAccount(job.email);
          const proxyLabel = job.noProxy || !acc?.proxy ? 'direct' : acc.proxy;
          if (loginsLast24hByProxy(proxyLabel) >= config.dailyLoginCap) {
            emitRun({
              runId: 0,
              email: job.email,
              flow: job.flow,
              status: 'failed',
              detail: `Đã đạt cap ${config.dailyLoginCap} login/24h cho IP "${proxyLabel}" — bỏ qua (thêm proxy để chạy tiếp)`,
            });
            this.current = null;
            continue;
          }
        }

        // Giãn nhịp ngẫu nhiên giữa các job (trừ job đầu)
        if (!first) {
          const waitMs = rand(config.pacing.minSec, config.pacing.maxSec) * 1000;
          emitRun({
            runId: 0,
            email: job.email,
            flow: job.flow,
            status: 'running',
            detail: `Giãn nhịp ${Math.round(waitMs / 1000)}s trước khi chạy`,
          });
          await this.interruptibleSleep(waitMs);
          if (this.stopRequested) break;
        }
        first = false;

        const t0 = Date.now();
        try {
          await runSingle(job.email, job.flow, { noProxy: job.noProxy });
        } catch {
          // runSingle đã ghi log/trạng thái; tiếp tục job kế
        }
        this.durations.push(Date.now() - t0);
        if (this.durations.length > 20) this.durations.shift();
        this.done++;
        this.current = null;
      }
    } finally {
      this.running = false;
      this.current = null;
    }
  }

  private async interruptibleSleep(ms: number) {
    const step = 1000;
    let waited = 0;
    while (waited < ms && !this.stopRequested) {
      await sleep(Math.min(step, ms - waited));
      waited += step;
    }
  }
}

export const scheduler = new Scheduler();
