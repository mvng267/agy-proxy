/**
 * Phép đo dứt điểm: tài khoản @luongthevinhhp.edu.vn có TỰ cấp được GCP project không?
 *
 * Vì sao cần script riêng: gọi model qua OmniRoute trả 422 `missing_project_id`, và đã có
 * hai cách giải thích trái ngược — (a) domain không cho tạo project, phải nhờ admin;
 * (b) credential ổn, chỉ là OmniRoute không chạy bước onboard. Script này tách bạch chúng:
 * nó chạy ĐÚNG recipe của `discoverProject()` (node UA + x-goog-api-client → onboardUser
 * tier free-tier) trên credential thật, ngoài mọi gateway.
 *
 * Trả về project id ⇒ (b) đúng, không cần admin.
 * Google từ chối         ⇒ (a) đúng, phải nhờ admin Workspace.
 *
 * Chạy:
 *   npx tsx scripts/do-cap-project.mts                 # đọc mọi credential target=agy trong store
 *   npx tsx scripts/do-cap-project.mts <refresh_token> # đo một token rời
 */
import { refreshAccessToken, discoverProject } from '../src/gateway/antigravity.js';

interface KetQua {
  email: string;
  ok: boolean;
  projectId?: string;
  loi?: string;
}

/** Bóc refresh token khỏi credential — store lưu JSON, nhưng cũng chấp nhận token thô. */
function bocRefreshToken(value: string): string | null {
  const s = value.trim();
  if (s.startsWith('1//')) return s;
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    const rt = j.refresh_token ?? j.refreshToken;
    return typeof rt === 'string' && rt ? rt : null;
  } catch {
    return null;
  }
}

async function doMot(email: string, refreshToken: string): Promise<KetQua> {
  try {
    const { accessToken } = await refreshAccessToken(refreshToken);
    const projectId = await discoverProject(accessToken);
    return { email, ok: true, projectId };
  } catch (e) {
    return { email, ok: false, loi: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const dsach: Array<{ email: string; refreshToken: string }> = [];

  if (arg) {
    const rt = bocRefreshToken(arg);
    if (!rt) {
      console.error('Tham số không phải refresh token hợp lệ (cần dạng 1//… hoặc JSON có refresh_token)');
      process.exit(2);
    }
    dsach.push({ email: '(token rời)', refreshToken: rt });
  } else {
    const { store } = await import('../src/store/index.js');
    for (const c of store.listCredentials()) {
      if (c.target !== 'agy' && c.target !== 'antigravity') continue;
      const rt = bocRefreshToken(c.value);
      if (rt) dsach.push({ email: c.email, refreshToken: rt });
    }
    if (!dsach.length) {
      console.error('Không có credential agy/antigravity nào trong store — cần đăng nhập ít nhất 1 account trước.');
      process.exit(1);
    }
  }

  console.log(`Đo ${dsach.length} account…\n`);
  const kq: KetQua[] = [];
  for (const { email, refreshToken } of dsach) {
    const r = await doMot(email, refreshToken);
    kq.push(r);
    console.log(r.ok ? `  ✓ ${r.email} → project ${r.projectId}` : `  ✗ ${r.email} → ${r.loi}`);
  }

  const song = kq.filter((r) => r.ok).length;
  console.log(`\nTự cấp được project: ${song}/${kq.length}`);
  if (!song) process.exit(1);
}

await main();
