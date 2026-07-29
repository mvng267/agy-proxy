import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { previewTool, applyTool, undoTool, toolStatus, ToolWriteError, applyMarkerBlock, removeMarkerBlock } from '../src/tools/writer.js';
import { TOOLS, MARKERS, type SetupValues } from '../src/tools/registry.js';

/** Mọi test dùng HOME tạm — KHÔNG bao giờ đụng home thật. */
function tmpHome(): string {
  return mkdtempSync(resolve(tmpdir(), 'agy-home-'));
}

const V: SetupValues = {
  anthropicBaseUrl: 'http://127.0.0.1:7788',
  openaiBaseUrl: 'http://127.0.0.1:7788/proxy/v1',
  apiKey: 'agy-test-key',
  model: 'kr/claude-sonnet-4',
  smallModel: 'kr/claude-haiku-4-5',
};

test('tạo file mới khi chưa có', () => {
  const home = tmpHome();
  const r = applyTool('claude-profile', V, home);
  assert.equal(r.created, true);
  assert.equal(r.backup, null);
  const j = JSON.parse(readFileSync(r.path, 'utf8'));
  assert.equal(j.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:7788');
  assert.equal(j.env.ANTHROPIC_MODEL, 'kr/claude-sonnet-4');
  assert.ok(!j.env.ANTHROPIC_BASE_URL.endsWith('/v1'), 'base URL Claude Code KHÔNG được kèm /v1');
});

test('MERGE giữ nguyên mọi khoá lạ trong settings.json', () => {
  const home = tmpHome();
  mkdirSync(resolve(home, '.claude'), { recursive: true });
  const original = {
    permissions: { allow: ['Bash'] },
    hooks: { PreToolUse: [{ x: 1 }] },
    enabledPlugins: ['a'],
    theme: 'dark',
    model: 'opus',
    env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' },
  };
  writeFileSync(resolve(home, '.claude/settings.json'), JSON.stringify(original, null, 2));

  applyTool('claude', V, home);
  const after = JSON.parse(readFileSync(resolve(home, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(after.permissions, original.permissions, 'permissions phải giữ nguyên');
  assert.deepEqual(after.hooks, original.hooks, 'hooks phải giữ nguyên');
  assert.deepEqual(after.enabledPlugins, original.enabledPlugins);
  assert.equal(after.theme, 'dark');
  assert.equal(after.model, 'opus');
  assert.equal(after.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '80', 'env cũ phải giữ');
  assert.equal(after.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:7788', 'env mới phải thêm');
});

test('backup được tạo và undo khôi phục BYTE-IDENTICAL', () => {
  const home = tmpHome();
  mkdirSync(resolve(home, '.claude'), { recursive: true });
  const path = resolve(home, '.claude/settings.json');
  const original = JSON.stringify({ theme: 'light', env: { A: '1' } }, null, 2);
  writeFileSync(path, original);

  const r = applyTool('claude', V, home);
  assert.ok(r.backup, 'phải tạo backup');
  assert.notEqual(readFileSync(path, 'utf8'), original);

  const u = undoTool('claude', home);
  assert.equal(u.restored, true);
  assert.equal(readFileSync(path, 'utf8'), original, 'phải khôi phục y hệt từng byte');
});

test('khối marker: áp 2 lần chỉ còn 1 khối, gỡ sạch', () => {
  const home = tmpHome();
  mkdirSync(resolve(home, '.codex'), { recursive: true });
  const path = resolve(home, '.codex/config.toml');
  writeFileSync(path, 'existing_key = "giu-nguyen"\n');

  applyTool('codex', V, home);
  applyTool('codex', V, home);
  const cur = readFileSync(path, 'utf8');
  assert.equal(cur.split(MARKERS.begin).length - 1, 1, 'chỉ được 1 khối marker');
  assert.ok(cur.includes('existing_key = "giu-nguyen"'), 'nội dung cũ phải còn');
  assert.ok(cur.includes('base_url = "http://127.0.0.1:7788/proxy/v1"'));

  const cleaned = removeMarkerBlock(cur);
  assert.ok(!cleaned.includes(MARKERS.begin));
  assert.ok(cleaned.includes('existing_key = "giu-nguyen"'));
});

test('JSON hỏng → TỪ CHỐI ghi (trừ khi overwrite)', () => {
  const home = tmpHome();
  mkdirSync(resolve(home, '.claude'), { recursive: true });
  writeFileSync(resolve(home, '.claude/settings.json'), '{ day khong phai json ');
  assert.throws(() => applyTool('claude', V, home), ToolWriteError);
  assert.doesNotThrow(() => applyTool('claude', V, home, true), 'overwrite=true thì cho ghi');
});

test('chặn ghi ra ngoài HOME', () => {
  assert.throws(() => applyTool('claude', V, '/'), ToolWriteError);
  assert.throws(() => applyTool('claude', V, ''), ToolWriteError);
});

test('preview không ghi gì ra đĩa', () => {
  const home = tmpHome();
  const p = previewTool('codex', V, home);
  assert.ok(p.after.includes('agyproxy'));
  assert.equal(p.before, null);
  assert.equal(existsSync(p.path), false, 'preview KHÔNG được tạo file');
});

test('toolStatus phản ánh đúng đã cấu hình hay chưa', () => {
  const home = tmpHome();
  assert.equal(toolStatus('claude-profile', home).configured, false);
  applyTool('claude-profile', V, home);
  const st = toolStatus('claude-profile', home);
  assert.equal(st.configured, true);
  assert.equal(st.model, 'kr/claude-sonnet-4');
});

test('undo profile riêng = xoá file (ta tự tạo)', () => {
  const home = tmpHome();
  const r = applyTool('claude-profile', V, home);
  assert.ok(existsSync(r.path));
  undoTool('claude-profile', home);
  assert.equal(existsSync(r.path), false);
});

test('giữ tối đa 5 backup', () => {
  const home = tmpHome();
  mkdirSync(resolve(home, '.claude'), { recursive: true });
  writeFileSync(resolve(home, '.claude/settings.json'), '{}');
  for (let i = 0; i < 8; i++) applyTool('claude', V, home);
  const baks = readdirSync(resolve(home, '.claude')).filter((f) => f.includes('.agybak-'));
  assert.ok(baks.length <= 5, `giữ tối đa 5 backup, đang có ${baks.length}`);
});

test('applyMarkerBlock/removeMarkerBlock là hàm thuần, idempotent', () => {
  const block = `${MARKERS.begin}\nx = 1\n${MARKERS.end}`;
  const a = applyMarkerBlock('', block);
  const b = applyMarkerBlock(a, block);
  assert.equal(a.split(MARKERS.begin).length, b.split(MARKERS.begin).length);
  assert.equal(removeMarkerBlock(b).trim(), '');
});

test('mọi tool đăng ký đều có path nằm trong HOME', () => {
  const home = '/Users/test-home';
  for (const [id, def] of Object.entries(TOOLS)) {
    assert.ok(def.configPath(home).startsWith(home), `${id} ghi ra ngoài home`);
  }
});

test('undo: gỡ khối xong file rỗng thì XOÁ hẳn (không để lại file rỗng)', () => {
  const home = tmpHome();
  applyTool('gemini', V, home);
  const p = resolve(home, '.gemini/.env');
  assert.ok(existsSync(p));
  const r = undoTool('gemini', home);
  assert.equal(r.restored, true);
  assert.equal(existsSync(p), false, 'file do ta tạo, gỡ xong phải biến mất');
});

test('undo: file rỗng còn sót từ lần trước vẫn dọn được', () => {
  const home = tmpHome();
  mkdirSync(resolve(home, '.gemini'), { recursive: true });
  writeFileSync(resolve(home, '.gemini/.env'), '   \n');
  const r = undoTool('gemini', home);
  assert.equal(r.restored, true);
  assert.equal(existsSync(resolve(home, '.gemini/.env')), false);
});
