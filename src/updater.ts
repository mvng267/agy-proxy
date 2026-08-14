import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import log from './lib/logger.js';

/**
 * Kiểm tra + cài bản mới từ GitHub.
 *
 * Logic này vốn CHỈ nằm trong bin/agyproxy.mjs nên dashboard không dùng lại được —
 * người dùng phải SSH vào máy mới cập nhật được. Tách ra đây để cả CLI lẫn API
 * `/api/system/update` dùng chung một đường, không có bản thứ hai để lệch nhau.
 */

const execFileAsync = promisify(execFile);
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'mvng267/agy-proxy';

function localVersion(): string {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** So sánh semver dạng x.y.z. >0 nghĩa là a mới hơn b. */
export function cmpVersion(a: string, b: string): number {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  /** Cài bằng git pull được không — quyết định UI hiện nút hay chỉ hướng dẫn. */
  canSelfUpdate: boolean;
  /** SHA đang chạy / SHA mới nhất trên main. Null khi không đọc được. */
  localSha: string | null;
  remoteSha: string | null;
  /** Số commit đang thiếu so với origin/main. Null khi chưa đo được. */
  behind: number | null;
  /** Tiêu đề vài commit mới nhất — để người bấm biết mình sắp cài gì. */
  commits: string[];
  error?: string;
}

/**
 * Có bản mới không? So theo COMMIT, không theo version.
 *
 * Bản cũ dùng `cmpVersion(latest, current) > 0`. Nhưng version là thứ người ta QUÊN bump:
 * đo ngày 12/08/2026, 8 commit gần nhất — kể cả bản vá vòng quota tắc 28 giờ — đều không
 * tăng version, nên local và remote cùng `2.18.1` và dashboard báo "đã là bản mới nhất"
 * suốt trong khi thiếu 8 commit. Commit SHA thì không thể quên.
 *
 * So bằng TIỀN TỐ vì hai nguồn cho độ dài khác nhau: `git rev-parse --short` trả 7 ký tự,
 * API GitHub trả đủ 40. So thẳng chuỗi là luôn khác → báo có bản mới vĩnh viễn.
 */
export function coBanMoi(v: {
  localSha: string | null;
  remoteSha: string | null;
  /** Số commit đang thiếu, khi đã đo được bằng `git rev-list HEAD..origin/main`. */
  behind?: number | null;
}): boolean {
  const { localSha: a, remoteSha: b, behind } = v;
  // Thiếu một trong hai thì KHÔNG đoán bừa — báo nhầm khiến người dùng bấm vào một tiến
  // trình chắc chắn thất bại.
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  if (a.slice(0, n) === b.slice(0, n)) return false;

  /**
   * SHA khác nhau CHƯA CHẮC là có bản mới — có thể local đang ĐI TRƯỚC remote.
   *
   * Bắt được đúng lỗi này khi chạy thử trên máy dev: vừa commit xong chưa push, `behind`
   * = 0 mà `hasUpdate` = true. Người dùng bấm Cập nhật thì `git pull --ff-only` không kéo
   * gì về, còn thẻ vẫn báo "có bản mới" mãi.
   *
   * Đo được `behind` thì nó là câu trả lời chính xác. Không đo được (chưa fetch, không
   * phải git checkout) thì đành dựa vào SHA khác nhau.
   */
  if (typeof behind === 'number') return behind > 0;
  return true;
}

async function fetchRemoteVersion(): Promise<string> {
  // API GitHub trước: raw.githubusercontent.com dính CDN cache tới vài phút, nên vừa
  // push xong hỏi ngay vẫn ra bản cũ.
  const api = await fetch(`https://api.github.com/repos/${REPO}/contents/package.json?ref=main`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'agyproxy' },
    signal: AbortSignal.timeout(15_000),
  });
  if (api.ok) {
    const j = (await api.json()) as { content?: string };
    if (j.content) return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')).version;
  }
  const raw = await fetch(`https://raw.githubusercontent.com/${REPO}/main/package.json`, {
    // Ép bỏ cache CDN bằng query, `cache:'no-store'` không có trong undici RequestInit.
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!raw.ok) throw new Error(`HTTP ${raw.status}`);
  return JSON.parse(await raw.text()).version;
}

/** Có phải bản cài từ git (pull được) không. */
export function isGitCheckout(): boolean {
  return existsSync(resolve(ROOT, '.git'));
}

/** SHA của HEAD cục bộ. Null nếu không phải git checkout. */
async function localCommit(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { timeout: 15_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** SHA mới nhất của `main` trên GitHub. */
async function fetchRemoteCommit(): Promise<string | null> {
  const r = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'agyproxy' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { sha?: string };
  return j.sha ?? null;
}

/**
 * Đếm commit đang thiếu + lấy tiêu đề của chúng.
 *
 * `git fetch` trước, nếu không `origin/main` là bản đã cache từ lần pull cuối và số đếm
 * luôn ra 0. Fetch không đụng gì tới cây làm việc nên an toàn khi đang phục vụ request.
 */
async function dangThieu(): Promise<{ behind: number | null; commits: string[] }> {
  try {
    await execFileAsync('git', ['-C', ROOT, 'fetch', '--quiet', 'origin', 'main'], { timeout: 60_000 });
    const { stdout: n } = await execFileAsync('git', ['-C', ROOT, 'rev-list', '--count', 'HEAD..origin/main'], { timeout: 30_000 });
    const { stdout: ds } = await execFileAsync(
      'git',
      ['-C', ROOT, 'log', '--oneline', '--no-decorate', '-8', 'HEAD..origin/main'],
      { timeout: 30_000 },
    );
    return {
      behind: Number(n.trim()) || 0,
      commits: ds.trim().split('\n').filter(Boolean),
    };
  } catch {
    return { behind: null, commits: [] };
  }
}

export async function checkUpdate(): Promise<UpdateCheck> {
  const current = localVersion();
  const canSelfUpdate = isGitCheckout();
  const localSha = await localCommit();
  try {
    // Hỏi song song: hai lời gọi mạng độc lập, không cần đợi nhau.
    const [latest, remoteSha] = await Promise.all([
      fetchRemoteVersion().catch(() => null),
      fetchRemoteCommit().catch(() => null),
    ]);
    /**
     * Đo `behind` TRƯỚC khi kết luận. SHA khác nhau chưa đủ: local có thể đang đi trước
     * remote (vừa commit chưa push) — khi đó không có gì để kéo về.
     *
     * Chỉ `git fetch` khi SHA đã khác nhau, để không tốn mạng cho trường hợp thường gặp
     * nhất là "đang ở bản mới nhất".
     */
    const shaKhac = coBanMoi({ localSha, remoteSha });
    const { behind, commits } = shaKhac && canSelfUpdate ? await dangThieu() : { behind: 0, commits: [] };
    const hasUpdate = coBanMoi({ localSha, remoteSha, behind: canSelfUpdate ? behind : null });
    return {
      current,
      latest,
      hasUpdate,
      canSelfUpdate,
      localSha,
      remoteSha,
      behind,
      commits,
      ...(latest === null && remoteSha === null ? { error: 'không hỏi được GitHub' } : {}),
    };
  } catch (e: any) {
    return {
      current,
      latest: null,
      hasUpdate: false,
      canSelfUpdate,
      localSha,
      remoteSha: null,
      behind: null,
      commits: [],
      error: String(e?.message ?? e),
    };
  }
}

export interface UpdateStep {
  step: string;
  ok: boolean;
  detail?: string;
}

/**
 * Cài bản mới. KHÔNG tự restart — người gọi quyết định thời điểm, vì restart giữa lúc
 * đang phục vụ request sẽ cắt ngang stream của client.
 *
 * Chỉ chạy được trên bản cài từ git. Bản npm global thì `git pull` vô nghĩa, và tự
 * `npm install -g` từ tiến trình server là tự ghi đè lên chính mình khi đang chạy.
 */
export async function runUpdate(onStep?: (s: UpdateStep) => void): Promise<UpdateStep[]> {
  const steps: UpdateStep[] = [];
  const push = (s: UpdateStep) => {
    steps.push(s);
    onStep?.(s);
    log[s.ok ? 'info' : 'error'](`update: ${s.step}${s.detail ? ' — ' + s.detail : ''}`);
  };

  if (!isGitCheckout()) {
    push({ step: 'kiểm tra', ok: false, detail: 'không phải bản cài từ git — cập nhật bằng `agyproxy update` trên máy chủ' });
    return steps;
  }

  const run = async (step: string, cmd: string, args: string[], cwd = ROOT, env?: NodeJS.ProcessEnv) => {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd, timeout: 300_000, maxBuffer: 8 << 20,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      push({ step, ok: true, detail: (stdout || stderr).trim().split('\n').slice(-2).join(' ').slice(0, 200) });
      return true;
    } catch (e: any) {
      push({ step, ok: false, detail: String(e?.stderr || e?.message || e).slice(0, 300) });
      return false;
    }
  };

  // `web/dist` ĐƯỢC commit vào repo (server serve dashboard từ đó), nên mỗi lần build
  // sinh hash file mới là thư mục "bẩn" ngay. Nếu coi đó là "code sắp mất" thì nút Cập
  // nhật chỉ chạy được ĐÚNG MỘT LẦN rồi tắc vĩnh viễn — gặp thật trên production.
  // Dist là sản phẩm build, không phải code người viết: dọn sạch trước khi pull.
  try {
    await execFileAsync('git', ['-C', ROOT, 'checkout', '--', 'web/dist'], { timeout: 60_000 });
  } catch { /* chưa có thay đổi nào để dọn */ }
  try {
    await execFileAsync('git', ['-C', ROOT, 'clean', '-fd', 'web/dist'], { timeout: 60_000 });
  } catch { /* không sao */ }

  // Còn thay đổi NGOÀI web/dist thì mới thật sự là code chưa commit — dừng lại.
  try {
    const { stdout } = await execFileAsync('git', ['-C', ROOT, 'status', '--porcelain'], { timeout: 30_000 });
    const dirty = stdout
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      // package-lock.json bị npm install sửa là chuyện thường, không phải code người viết.
      .filter((f) => !f.startsWith('web/dist/') && f !== 'package-lock.json' && f !== 'web/package-lock.json');
    if (dirty.length) {
      push({ step: 'kiểm tra', ok: false, detail: `thư mục có thay đổi chưa commit (${dirty.slice(0, 3).join(', ')}) — dừng để không mất code` });
      return steps;
    }
  } catch (e: any) {
    push({ step: 'kiểm tra', ok: false, detail: String(e?.message ?? e).slice(0, 200) });
    return steps;
  }

  // package-lock có thể lệch sau lần install trước → pull sẽ fail. Bỏ thay đổi cục bộ.
  try {
    await execFileAsync('git', ['-C', ROOT, 'checkout', '--', 'package-lock.json', 'web/package-lock.json'], { timeout: 60_000 });
  } catch { /* file có thể không tồn tại */ }

  /**
   * Ghi lại mốc để LÙI ĐƯỢC.
   *
   * Trước đây `git pull` xong mà `npm install` chết là cây làm việc ở code MỚI với
   * dependency CŨ — trạng thái lai không chạy nổi và không có đường về. Phải SSH vào
   * `git reset --hard` bằng tay, mà muốn thế thì phải biết SHA cũ là gì.
   */
  const mocCu = await localCommit();
  const lui = async (viSao: string) => {
    if (!mocCu) return;
    try {
      await execFileAsync('git', ['-C', ROOT, 'reset', '--hard', mocCu], { timeout: 60_000 });
      push({ step: 'lùi lại', ok: true, detail: `${viSao} → đã quay về ${mocCu.slice(0, 8)}` });
    } catch (e: any) {
      // Lùi cũng hỏng: nói rõ SHA để người vận hành làm tay, đừng để họ tự mò.
      push({ step: 'lùi lại', ok: false, detail: `KHÔNG lùi được, chạy tay: git reset --hard ${mocCu.slice(0, 12)} (${String(e?.message ?? e).slice(0, 120)})` });
    }
  };

  if (!(await run('git pull', 'git', ['-C', ROOT, 'pull', '--ff-only']))) return steps;
  if (!(await run('npm install', 'npm', ['install', '--omit=dev', '--no-fund', '--no-audit']))) {
    // Dependency không cài được thì code mới chắc chắn không chạy — lùi.
    await lui('npm install thất bại');
    return steps;
  }

  // Web build nằm trong repo nhưng dist có thể cũ hơn src sau khi pull.
  //
  // NODE_ENV phải ép về 'development' cho web: service systemd đặt NODE_ENV=production,
  // tiến trình server kế thừa, và npm TỰ BỎ devDependencies khi thấy biến đó — kể cả
  // khi không truyền --omit=dev. Kết quả: web/node_modules thiếu vite + @types/node,
  // `tsc -b` chết với "Cannot find type definition file for 'vite/client'".
  // Đo thật trên máy production, bắt được đúng bằng cách bấm nút Cập nhật.
  let webOk = true;
  if (existsSync(resolve(ROOT, 'web/package.json'))) {
    const webDir = resolve(ROOT, 'web');
    // HAI biến môi trường KHÁC NHAU cho hai bước — trộn làm một là hỏng một trong hai:
    //  · install cần NODE_ENV=development, nếu không npm bỏ devDependencies (vite,
    //    @types/node) và `tsc -b` chết với "Cannot find type definition for 'vite/client'".
    //  · build cần NODE_ENV=production, nếu không Vite BỎ MINIFY — đo thật trên production:
    //    chunk khởi động 477 KB / 218 dòng thay vì 281 KB / 9 dòng.
    webOk = await run('npm install (web)', 'npm', ['install', '--no-fund', '--no-audit'], webDir, {
      NODE_ENV: 'development',
    });
    if (webOk) webOk = await run('build web', 'npm', ['run', 'build'], webDir, { NODE_ENV: 'production' });
  }

  /**
   * Build web hỏng = dashboard chạy bản dist CŨ. Trước đây bước này vẫn báo "xong" dù
   * build lỗi, nên người dùng tưởng đã cập nhật xong.
   *
   * CỐ Ý KHÔNG lùi ở đây, khác với nhánh `npm install`: backend đã lên code mới và chạy
   * được: chỉ giao diện là cũ. Lùi lại là vứt luôn bản vá backend để đổi lấy một dashboard
   * mới — đánh đổi sai, nhất là khi bản vá đó đang sửa sự cố production.
   */
  if (!webOk) {
    push({ step: 'xong', ok: false, detail: `mã nguồn đã lên v${localVersion()} nhưng BUILD WEB LỖI — backend đã cập nhật, dashboard vẫn chạy giao diện cũ` });
    return steps;
  }

  push({ step: 'xong', ok: true, detail: `đã cài v${localVersion()} — khởi động lại để áp dụng` });
  return steps;
}
