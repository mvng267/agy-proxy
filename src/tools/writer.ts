import {
  existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync,
  readdirSync, unlinkSync, realpathSync, chmodSync,
} from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { TOOLS, MARKERS, type SetupValues, type ToolId } from './registry.js';

/**
 * Ghi cấu hình vào $HOME cho từng CLI tool — CÓ backup + gỡ được.
 *
 * Quy tắc an toàn (thứ tự quan trọng):
 *  1. Allowlist đường dẫn: phải nằm trong home VÀ khớp đúng configPath(home).
 *  2. Backup trước mọi lần ghi (.agybak-<ISO>), giữ 5 bản mới nhất.
 *  3. MERGE, không đè: JSON hỏng → từ chối (trừ khi overwrite).
 *  4. Khối marker cho file text → idempotent, gỡ = xoá khối.
 *  5. Ghi atomic (tmp + rename), chmod 0600 nếu chứa key.
 *  KHÔNG BAO GIỜ sửa ~/.zshrc hay shell rc.
 */

const BAK_SUFFIX = '.agybak-';
const KEEP_BACKUPS = 5;

export class ToolWriteError extends Error {
  status = 400;
  constructor(msg: string) {
    super(msg);
  }
}

/** Resolve tổ tiên tồn tại gần nhất (macOS: /var → /private/var là symlink). */
function realNearest(p: string): string {
  let cur = resolve(p);
  const parts: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return resolve(p);
    parts.unshift(basename(cur));
    cur = parent;
  }
  return resolve(realpathSync(cur), ...parts);
}

/** Chặn ghi ra ngoài home / sai đường dẫn đăng ký. */
function assertAllowed(id: ToolId, path: string, home: string): void {
  if (!home || home === '/' || home.length < 4) throw new ToolWriteError('HOME không hợp lệ');
  const expect = TOOLS[id].configPath(home);
  if (resolve(path) !== resolve(expect)) throw new ToolWriteError('Đường dẫn không khớp đăng ký của tool');
  const realTarget = realNearest(path);
  const realHome = realNearest(home);
  if (!realTarget.startsWith(realHome + '/')) throw new ToolWriteError('Từ chối ghi ra ngoài thư mục HOME');
}

function deepMerge(base: any, patch: any): any {
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return patch;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] ?? {}, v) : v;
  }
  return out;
}

/** Chèn/thay khối marker trong file text. Idempotent. */
export function applyMarkerBlock(current: string, block: string): string {
  const b = current.indexOf(MARKERS.begin);
  const e = current.indexOf(MARKERS.end);
  if (b >= 0 && e > b) {
    return current.slice(0, b) + block + current.slice(e + MARKERS.end.length);
  }
  return (current.trimEnd() + (current.trim() ? '\n\n' : '') + block + '\n');
}

/** Xoá khối marker (dùng khi Gỡ). */
export function removeMarkerBlock(current: string): string {
  const b = current.indexOf(MARKERS.begin);
  const e = current.indexOf(MARKERS.end);
  if (b < 0 || e <= b) return current;
  return (current.slice(0, b) + current.slice(e + MARKERS.end.length)).replace(/\n{3,}/g, '\n\n').trimStart();
}

export interface Preview {
  id: ToolId;
  label: string;
  path: string;
  installed: boolean;
  exists: boolean;
  before: string | null;
  after: string;
  notes?: string;
}

function computeAfter(id: ToolId, v: SetupValues, before: string | null, overwrite = false): string {
  const def = TOOLS[id];
  if (def.format === 'json') {
    let base: any = {};
    if (before && before.trim()) {
      try {
        base = JSON.parse(before);
      } catch {
        if (!overwrite) {
          throw new ToolWriteError(
            `${basename(def.configPath('~'))} hiện KHÔNG phải JSON hợp lệ — từ chối ghi để khỏi làm hỏng. ` +
              'Sửa file rồi thử lại, hoặc chọn ghi đè.',
          );
        }
      }
    }
    return JSON.stringify(deepMerge(base, def.patch(v) as Record<string, unknown>), null, 2) + '\n';
  }
  return applyMarkerBlock(before ?? '', def.patch(v) as string);
}

export function previewTool(id: ToolId, v: SetupValues, home = homedir(), overwrite = false): Preview {
  const def = TOOLS[id];
  const path = def.configPath(home);
  assertAllowed(id, path, home);
  const exists = existsSync(path);
  const before = exists ? readFileSync(path, 'utf8') : null;
  return {
    id, label: def.label, path,
    installed: def.detect(home).installed,
    exists, before,
    after: computeAfter(id, v, before, overwrite),
    notes: def.notes,
  };
}

function backup(path: string): string | null {
  if (!existsSync(path)) return null;
  const bak = `${path}${BAK_SUFFIX}${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(path, bak);
  // dọn bản cũ, giữ 5 bản mới nhất
  try {
    const dir = dirname(path);
    const name = basename(path);
    const olds = readdirSync(dir)
      .filter((f) => f.startsWith(name + BAK_SUFFIX))
      .sort()
      .reverse();
    for (const f of olds.slice(KEEP_BACKUPS)) unlinkSync(resolve(dir, f));
  } catch {
    /* dọn backup lỗi không được chặn việc ghi */
  }
  return bak;
}

export interface WriteResult {
  path: string;
  backup: string | null;
  created: boolean;
  after: string;
}

export function applyTool(id: ToolId, v: SetupValues, home = homedir(), overwrite = false): WriteResult {
  const p = previewTool(id, v, home, overwrite);
  mkdirSync(dirname(p.path), { recursive: true });
  const bak = backup(p.path);
  const tmp = p.path + '.tmp';
  writeFileSync(tmp, p.after);
  renameSync(tmp, p.path);
  try {
    chmodSync(p.path, 0o600); // file chứa API key
  } catch {
    /* hệ thống không hỗ trợ chmod */
  }
  return { path: p.path, backup: bak, created: !p.exists, after: p.after };
}

export interface UndoResult {
  restored: boolean;
  path: string;
  detail: string;
}

export function undoTool(id: ToolId, home = homedir()): UndoResult {
  const def = TOOLS[id];
  const path = def.configPath(home);
  assertAllowed(id, path, home);
  if (!existsSync(path)) return { restored: false, path, detail: 'File không tồn tại' };

  // 1) có backup → khôi phục bản mới nhất
  const dir = dirname(path);
  const name = basename(path);
  let baks: string[] = [];
  try {
    baks = readdirSync(dir).filter((f) => f.startsWith(name + BAK_SUFFIX)).sort().reverse();
  } catch {
    /* thư mục biến mất */
  }
  if (baks.length) {
    const src = resolve(dir, baks[0]!);
    copyFileSync(src, path);
    unlinkSync(src);
    return { restored: true, path, detail: `Đã khôi phục từ ${baks[0]}` };
  }

  // 2) file text có khối marker → gỡ khối. Gỡ xong mà file RỖNG thì xoá hẳn
  //    (file này do ta tạo ra, để lại file rỗng sẽ khiến lần Huỷ sau báo "không tìm thấy").
  if (def.format !== 'json') {
    const cur = readFileSync(path, 'utf8');
    if (cur.includes(MARKERS.begin)) {
      const next = removeMarkerBlock(cur);
      if (!next.trim()) {
        unlinkSync(path);
        return { restored: true, path, detail: 'Đã gỡ cấu hình và xoá file rỗng' };
      }
      writeFileSync(path, next);
      return { restored: true, path, detail: 'Đã gỡ khối cấu hình agyproxy' };
    }
    if (!cur.trim()) {
      unlinkSync(path); // file rỗng còn sót từ lần gỡ trước
      return { restored: true, path, detail: 'Đã xoá file rỗng còn sót' };
    }
  }

  // 3) file do ta tạo (profile riêng) → xoá
  if (id === 'claude-profile') {
    unlinkSync(path);
    return { restored: true, path, detail: 'Đã xoá profile agyproxy' };
  }
  return { restored: false, path, detail: 'Không có backup và không tìm thấy dấu vết agyproxy' };
}

export interface ToolStatus {
  id: ToolId;
  label: string;
  api: string;
  path: string;
  installed: boolean;
  via?: string;
  exists: boolean;
  configured: boolean;
  hasBackup: boolean;
  model?: string;
  notes?: string;
  unsupported?: string;
}

export function toolStatus(id: ToolId, home = homedir()): ToolStatus {
  const def = TOOLS[id];
  const path = def.configPath(home);
  const exists = existsSync(path);
  let configured = false;
  let model: string | undefined;
  if (exists) {
    const cur = readFileSync(path, 'utf8');
    if (def.format === 'json') {
      try {
        const j = JSON.parse(cur);
        if (id === 'opencode') {
          // opencode: nhận diện bằng khối provider riêng của ta
          configured = !!j?.provider?.agyproxy;
          model = typeof j?.model === 'string' ? j.model.replace(/^agyproxy\//, '') : undefined;
        } else {
          configured = !!j?.env?.ANTHROPIC_BASE_URL;
          model = j?.env?.ANTHROPIC_MODEL;
        }
      } catch {
        configured = false;
      }
    } else {
      configured = cur.includes(MARKERS.begin);
      model = cur.match(/^(?:model = "|OPENAI_MODEL=)([^"\n]+)"?/m)?.[1];
    }
  }
  let hasBackup = false;
  try {
    hasBackup = readdirSync(dirname(path)).some((f) => f.startsWith(basename(path) + BAK_SUFFIX));
  } catch {
    /* thư mục chưa có */
  }
  const det = def.detect(home);
  return { id, label: def.label, api: def.api, path, installed: det.installed, via: det.via, exists, configured, hasBackup, model, notes: def.notes, unsupported: def.unsupported };
}
