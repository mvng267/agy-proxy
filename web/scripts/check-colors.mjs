#!/usr/bin/env node
/**
 * Đếm màu hard-code trong mã nguồn web.
 *
 * Vì sao cần: dashboard có 3 chế độ theme (sáng/tối/theo máy) nhưng mọi lớp `bg-orange-500`,
 * `text-emerald-400`, `#334155`… đều CỐ ĐỊNH — chúng không đổi theo theme, nên chế độ sáng
 * hiển thị sai dù bảng token đã đúng. Script này là thước đo để chứng minh tiến độ token-hoá
 * bằng SỐ, không phải bằng cảm giác nhìn màn hình.
 *
 * Dùng:
 *   node scripts/check-colors.mjs                 # in bảng, exit 1 nếu > --max
 *   node scripts/check-colors.mjs --max=400       # ngưỡng tạm trong lúc chuyển đổi
 *   node scripts/check-colors.mjs --dir=src/components/ui
 *   node scripts/check-colors.mjs --file=src/components/pages/Pool.tsx --suggest
 *   node scripts/check-colors.mjs --hex-only
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

/** Họ màu Tailwind — cố ý KHÔNG gồm `white`/`black`/`transparent`/`current`. */
const FAMILIES =
  'orange|red|emerald|green|amber|yellow|blue|purple|violet|slate|zinc|gray|neutral|cyan|teal|pink|rose|indigo|sky|lime|fuchsia|stone';
const PREFIXES =
  'text|bg|border|ring|fill|stroke|from|to|via|shadow|decoration|outline|divide|accent|caret|placeholder';

const RE_CLASS = new RegExp(`\\b(?:${PREFIXES})-(?:${FAMILIES})-\\d{2,3}\\b`, 'g');
const RE_HEX = /#[0-9a-fA-F]{3,8}\b/g;

/**
 * Miễn trừ CÓ LÝ DO — không phải danh sách để nhét bừa file khó sửa vào.
 *
 * - `lib/theme.ts`: 2 hex cho `<meta name="theme-color">`. Đây là màu thanh địa chỉ trình
 *   duyệt / notch iOS, trình duyệt đọc thuộc tính HTML chứ không phải CSS, nên KHÔNG dùng
 *   được `var(--background)`.
 * - `login.html`: trang đăng nhập nằm ngoài React và ngoài Tailwind runtime (nó tự chứa
 *   `<style>`). Được xử lý riêng bằng CSS variable ở giai đoạn sau.
 */
const EXEMPT = [
  { path: 'src/lib/theme.ts', why: 'meta theme-color — trình duyệt đọc HTML, không đọc CSS var' },
  { path: 'src/login.html', why: 'trang tĩnh ngoài Tailwind, xử lý riêng bằng CSS var' },
];

/** Ánh xạ theo VAI TRÒ, không theo độ đậm. Chỉ để gợi ý — người quyết định. */
const SUGGEST = [
  [/\b(text|bg|border|ring|fill|stroke|divide)-(emerald|green)-\d{2,3}\b/, '$1-success', 'trạng thái khoẻ'],
  [/\b(text|bg|border|ring|fill|stroke|divide)-red-\d{2,3}\b/, '$1-destructive', 'lỗi / nguy hiểm'],
  [/\b(text|bg|border|ring|fill|stroke|divide)-(amber|yellow)-\d{2,3}\b/, '$1-warning', 'cảnh báo'],
  [/\b(text|bg|border|ring|fill|stroke|divide)-(blue|sky|indigo)-\d{2,3}\b/, '$1-info', 'thông tin'],
  [/\b(text|bg|border|ring|fill|stroke|divide)-(purple|violet|fuchsia)-\d{2,3}\b/, '$1-info', 'thông tin / nhãn phụ'],
  [/\b(text|bg|border|ring|fill|stroke|divide)-(slate|zinc|gray|neutral|stone)-\d{2,3}\b/, '$1-muted-foreground', 'nền / viền / chữ phụ'],
  // orange PHẢI người xem: vừa là màu nhấn (primary) vừa là cooldown (warning)
  [/\b(text|bg|border|ring|fill|stroke|divide)-orange-\d{2,3}\b/, '$1-primary HOẶC $1-warning', '⚠ CẦN NGƯỜI XEM — nhấn hay cảnh báo?'],
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'scripts']);
const EXTS = /\.(tsx?|jsx?|css|html)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.test(name)) out.push(full);
  }
  return out;
}

const isExempt = (rel) => EXEMPT.find((e) => rel === e.path);

function scan() {
  const only = arg('file');
  const dir = arg('dir', 'src');
  const hexOnly = flag('hex-only');

  const files = only ? [resolve(ROOT, only)] : walk(resolve(ROOT, dir));
  const rows = [];
  let total = 0;

  for (const f of files) {
    const rel = relative(ROOT, f);
    if (isExempt(rel)) continue;
    const src = readFileSync(f, 'utf8');
    const hits = [];
    if (!hexOnly) for (const m of src.matchAll(RE_CLASS)) hits.push(m[0]);
    for (const m of src.matchAll(RE_HEX)) hits.push(m[0]);
    if (hits.length) {
      rows.push({ rel, n: hits.length, hits });
      total += hits.length;
    }
  }
  rows.sort((a, b) => b.n - a.n);
  return { rows, total };
}

function suggestFor(file) {
  const rel = relative(ROOT, resolve(ROOT, file));
  const src = readFileSync(resolve(ROOT, file), 'utf8').split('\n');
  console.log(`\nĐỀ XUẤT cho ${rel} — script KHÔNG sửa file, người quyết định:\n`);
  let n = 0;
  src.forEach((line, i) => {
    const hits = [...line.matchAll(RE_CLASS)].map((m) => m[0]);
    if (!hits.length) return;
    n++;
    console.log(`  ${String(i + 1).padStart(4)}│ ${line.trim().slice(0, 100)}`);
    for (const h of new Set(hits)) {
      const rule = SUGGEST.find(([re]) => re.test(h));
      const to = rule ? h.replace(rule[0], rule[1]) : '(không có gợi ý)';
      console.log(`      └─ ${h}  →  ${to}${rule ? `   [${rule[2]}]` : ''}`);
    }
  });
  console.log(`\n  ${n} dòng cần xem.\n`);
}

// ---------------------------------------------------------------------------

if (flag('suggest')) {
  const f = arg('file');
  if (!f) {
    console.error('--suggest cần đi kèm --file=<đường dẫn>');
    process.exit(2);
  }
  suggestFor(f);
  process.exit(0);
}

const { rows, total } = scan();
const max = Number(arg('max', '0'));

if (rows.length) {
  console.log('\nMàu hard-code theo file:\n');
  for (const r of rows) {
    const top = [...new Set(r.hits)].slice(0, 4).join(' ');
    console.log(`  ${String(r.n).padStart(4)}  ${r.rel.padEnd(46)} ${top}`);
  }
}

console.log(`\n  Tổng: ${total}  (ngưỡng: ${max})`);
if (EXEMPT.length) {
  console.log('  Miễn trừ:');
  for (const e of EXEMPT) console.log(`    · ${e.path} — ${e.why}`);
}

if (total > max) {
  console.log(`\n  ✗ Vượt ngưỡng ${max}. Dùng --suggest --file=<đường dẫn> để xem gợi ý ánh xạ.\n`);
  process.exit(1);
}
console.log('\n  ✓ Đạt ngưỡng.\n');
