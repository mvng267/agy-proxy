import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { refreshAccessToken, discoverProject, generate } from '../../src/gateway/antigravity.js';

/**
 * Live smoke test — CHỈ chạy khi LIVE=1 (gọi Google thật, phụ thuộc mạng + quota).
 * Chứng minh recipe end-to-end với account EDU free-tier: refresh → project → generate.
 *   LIVE=1 node --import tsx --test test/live/smoke.test.ts
 */
const LIVE = process.env.LIVE === '1';

test('recipe end-to-end trả kết quả model', { skip: !LIVE }, async () => {
  const csv = readFileSync(resolve('data/credentials.csv'), 'utf8');
  const line = csv.split(/\r?\n/).find((l) => /,agy,1\/\//.test(l));
  assert.ok(line, 'cần ít nhất 1 credential agy trong CSV');
  const rt = line!.split(',')[2]!;

  const tok = await refreshAccessToken(rt);
  assert.ok(tok.accessToken.length > 50, 'access_token hợp lệ');

  const project = await discoverProject(tok.accessToken);
  assert.ok(project && project.length > 3, 'lấy được project');

  const r = await generate({
    accessToken: tok.accessToken,
    projectId: project,
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
  });
  assert.ok(r.text.toUpperCase().includes('PONG'), `model trả về: ${r.text}`);
});
