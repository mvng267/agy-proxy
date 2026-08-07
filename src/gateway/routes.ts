import type { FastifyInstance } from 'fastify';
import { syncFromStore } from './pool.js';
import { getSetting } from '../store/db.js';
import { setRrCursor } from './combo.js';
import { registerOpenAIDialect } from './dialects/openai.js';
import { registerAnthropicDialect } from './dialects/anthropic.js';
import { registerAdminRoutes } from './admin.js';
import { startGatewayBackground } from './background.js';

/**
 * Composition root của gateway. Nghiệp vụ nằm ở các module con:
 *  - engine.ts        — chọn account, failover, combo, health check (không có route)
 *  - dialects/openai  — /proxy/v1 + alias /v1, /openai/v1 (OpenAI wire-format)
 *  - dialects/anthropic — /v1/messages + alias (Anthropic Messages API, cho Claude Code)
 *  - dialects/wire.ts — helper wire-format dùng chung (SSE, chuyển đổi message)
 *  - admin.ts         — /api/gateway/*, /api/combos/* (tab UI)
 *  - background.ts    — job nền: refresh quota/token, dò Kiro, dọn lịch sử
 */
export type { UsageCtx } from './engine.js';

export async function registerGatewayRoutes(app: FastifyInstance): Promise<void> {
  syncFromStore(true);
  // Restore combo round-robin cursor từ DB (persist qua restart)
  const savedCursor = getSetting('comboRrCursor');
  if (savedCursor) setRrCursor(Number(savedCursor) || 0);

  registerOpenAIDialect(app);
  registerAnthropicDialect(app);
  registerAdminRoutes(app);
  startGatewayBackground();
}
