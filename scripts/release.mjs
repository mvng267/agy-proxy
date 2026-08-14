#!/usr/bin/env node
/**
 * Phát hành: tính version từ commit, ghi package.json, tạo git tag.
 *
 * Vì sao cần: version là thứ người ta quên bump. Đo ngày 12/08/2026, 8 commit liên tiếp —
 * kể cả bản vá vòng quota tắc 28 giờ trên production — đều giữ nguyên `2.18.1`, và repo
 * chưa có tag nào dù đã ở 2.18.x.
 *
 * KHÔNG dùng `npm version`: nó tự tạo commit theo khuôn riêng, còn ở đây version phải nằm
 * trong chính commit phát hành để `package.json` trên GitHub khớp với tag.
 *
 *   node scripts/release.mjs            # xem sẽ tăng lên bao nhiêu, KHÔNG ghi gì
 *   node scripts/release.mjs --apply    # ghi package.json + tạo tag
 *   node scripts/release.mjs --apply --push
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { mucTangGop, versionKeTiep } = await import(resolve(ROOT, 'src/lib/semver.ts'));

const APPLY = process.argv.includes('--apply');
const PUSH = process.argv.includes('--push');

const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim();

const pkgPath = resolve(ROOT, 'package.json');
const pkgRaw = readFileSync(pkgPath, 'utf8');
const hienTai = JSON.parse(pkgRaw).version;

// Tag gần nhất; chưa có tag nào thì lấy toàn bộ lịch sử.
let tagCuoi = '';
try {
  // `stderr: 'pipe'` để git không in "fatal: No names found" ra màn hình khi chưa có tag —
  // đó là trạng thái BÌNH THƯỜNG của lần phát hành đầu, không phải lỗi.
  tagCuoi = execFileSync('git', ['-C', ROOT, 'describe', '--tags', '--abbrev=0'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
} catch {
  /* chưa tag lần nào */
}

const range = tagCuoi ? `${tagCuoi}..HEAD` : 'HEAD';
const commits = git('log', '--format=%s%n%b%n---', range)
  .split('\n---')
  .map((s) => s.trim())
  .filter(Boolean);

if (!commits.length) {
  console.log(`Không có commit mới kể từ ${tagCuoi || 'đầu lịch sử'} — không phát hành.`);
  process.exit(0);
}

const muc = mucTangGop(commits);
const moi = versionKeTiep(hienTai, muc);

console.log(`  version hiện tại : ${hienTai}`);
console.log(`  từ tag           : ${tagCuoi || '(chưa có tag nào)'}`);
console.log(`  số commit        : ${commits.length}`);
console.log(`  mức tăng         : ${muc ?? 'KHÔNG (toàn refactor/chore/test)'}`);
console.log(`  version mới      : ${moi}`);
console.log();

if (!muc) {
  console.log('Không commit nào đổi hành vi người dùng thấy — không cần bump.');
  console.log('Muốn tag mốc hiện tại thì tạo tay: git tag -a v' + hienTai);
  process.exit(0);
}

if (!APPLY) {
  console.log('Đây là bản xem trước. Thêm --apply để ghi package.json và tạo tag.');
  process.exit(0);
}

// Cây làm việc phải sạch — trừ package.json mà chính script này sắp sửa.
const ban = git('status', '--porcelain')
  .split('\n')
  .map((l) => l.slice(3).trim())
  .filter(Boolean)
  .filter((f) => f !== 'package.json');
if (ban.length) {
  console.error(`Cây làm việc còn thay đổi chưa commit: ${ban.slice(0, 5).join(', ')}`);
  console.error('Commit hoặc stash trước khi phát hành.');
  process.exit(1);
}

// Sửa ĐÚNG một dòng version, giữ nguyên định dạng file (thụt lề, thứ tự khoá).
const raMoi = pkgRaw.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${moi}"`);
if (raMoi === pkgRaw) {
  console.error('Không tìm thấy trường "version" trong package.json.');
  process.exit(1);
}
writeFileSync(pkgPath, raMoi);

git('add', 'package.json');
git('commit', '-m', `chore(release): v${moi}`);
git('tag', '-a', `v${moi}`, '-m', `v${moi}`);
console.log(`✓ Đã ghi v${moi}, commit và tạo tag v${moi}`);

/**
 * Đưa bản vừa phát hành sang nhánh `production`.
 *
 * Vì sao cần hai nhánh: máy thật kéo bản cập nhật từ `production` (khoá `updateBranch`,
 * mặc định đúng nhánh này). `main` là nơi commit tự do — không tách ra thì mọi refactor dở
 * dang lập tức hiện thành "có bản mới" trên dashboard của máy đang phục vụ thật.
 *
 * Merge `--ff-only`: `production` chỉ được đi theo sau `main`, không bao giờ có commit
 * riêng. Nếu ai đó lỡ commit thẳng vào `production` thì lệnh này DỪNG thay vì tạo commit
 * merge làm hai nhánh phân kỳ vĩnh viễn.
 */
const NHANH_PH = 'production';
const nhanhHienTai = git('rev-parse', '--abbrev-ref', 'HEAD');
let daMerge = false;
try {
  const coNhanh = git('branch', '--list', NHANH_PH) || git('ls-remote', '--heads', 'origin', NHANH_PH);
  if (coNhanh) {
    git('checkout', NHANH_PH);
    git('merge', '--ff-only', nhanhHienTai);
  } else {
    // Lần đầu: tạo nhánh ngay tại mốc phát hành này.
    git('checkout', '-b', NHANH_PH);
    console.log(`  (tạo mới nhánh ${NHANH_PH})`);
  }
  daMerge = true;
  git('checkout', nhanhHienTai);
  console.log(`✓ Đã đưa v${moi} sang nhánh ${NHANH_PH}`);
} catch (e) {
  // Quay về nhánh cũ để không bỏ người chạy ở trạng thái lơ lửng.
  try { git('checkout', nhanhHienTai); } catch { /* đã ở đó rồi */ }
  console.error(`✗ Không merge được sang ${NHANH_PH}: ${e?.message ?? e}`);
  console.error(`  Bản phát hành v${moi} vẫn nằm trên ${nhanhHienTai}. Xử lý tay rồi merge lại.`);
}

if (PUSH) {
  git('push', 'origin', nhanhHienTai);
  if (daMerge) git('push', 'origin', NHANH_PH);
  git('push', 'origin', `v${moi}`);
  console.log('✓ Đã push cả hai nhánh và tag');
} else {
  console.log(
    `Đẩy lên: git push origin ${nhanhHienTai}` +
      (daMerge ? ` && git push origin ${NHANH_PH}` : '') +
      ` && git push origin v${moi}`,
  );
}
