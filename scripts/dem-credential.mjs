#!/usr/bin/env node
/**
 * Đếm credential theo target, bỏ qua cái đã `health=dead`.
 *
 * Tách khỏi shell script vì parser CSV có dấu nháy và dấu phẩy — nhúng vào bash phải
 * escape nhiều tầng, và bản nhúng đã hỏng im lặng (in "không đếm được" rồi đi tiếp).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSV = process.argv[2] ?? resolve(process.env.HOME ?? '', '.agyproxy/data/credentials.csv');

/** Parser CSV đúng chuẩn — `value` là JSON chứa dấu phẩy, split(',') sẽ lệch cột. */
function parseCsv(t) {
  const rows = [];
  let f = '', row = [], q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

let rows;
try {
  rows = parseCsv(readFileSync(CSV, 'utf8'));
} catch (e) {
  console.error('không đọc được ' + CSV + ': ' + e.message);
  process.exit(1);
}

const head = rows[0] ?? [];
const theoTarget = {};
let chet = 0;
for (const r of rows.slice(1)) {
  if (!r[0]) continue;
  const o = Object.fromEntries(head.map((k, i) => [k, r[i] ?? '']));
  if (o.health === 'dead') { chet++; continue; }
  theoTarget[o.target] = (theoTarget[o.target] ?? 0) + 1;
}

const tong = Object.values(theoTarget).reduce((a, b) => a + b, 0);
console.log('  credential sống: ' + tong + ' — ' +
  Object.entries(theoTarget).map(([k, v]) => k + ' ' + v).join(' · '));
if (chet) console.log('  bỏ qua ' + chet + ' credential health=dead');
