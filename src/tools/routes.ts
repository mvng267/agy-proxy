import type { FastifyInstance } from 'fastify';
import { homedir } from 'node:os';
import { config } from '../config.js';
import { emitLog } from '../events.js';
import { TOOLS, TOOL_IDS, type SetupValues, type ToolId } from './registry.js';
import { previewTool, applyTool, undoTool, toolStatus, ToolWriteError } from './writer.js';

/**
 * API cấu hình CLI tool 1 chạm. Nằm dưới /api/* nên đã được auth dashboard bảo vệ.
 * Ghi vào $HOME → mọi thao tác đều preview + backup + gỡ được.
 */

function baseUrls(): { anthropic: string; openai: string } {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const root = `http://${host}:${config.port}`;
  return { anthropic: root, openai: `${root}/proxy/v1` };
}

function valuesFrom(body: any): SetupValues {
  const u = baseUrls();
  return {
    anthropicBaseUrl: String(body?.anthropicBaseUrl || u.anthropic),
    openaiBaseUrl: String(body?.openaiBaseUrl || u.openai),
    apiKey: String(body?.apiKey ?? config.gateway.apiKey ?? ''),
    model: String(body?.model || config.gateway.anthropicBigModel),
    smallModel: body?.smallModel ? String(body.smallModel) : config.gateway.anthropicSmallModel,
  };
}

/** Không cho cấu hình tool trỏ vào gateway đang mở toang (không key + bind ra ngoài). */
function guardOpenRelay(): string | null {
  const open = config.host === '0.0.0.0' || config.host === '::';
  if (open && !config.gateway.apiKey) {
    return 'Gateway đang mở ra mạng (host 0.0.0.0) mà CHƯA đặt API key — đặt key ở Cấu hình → Gateway trước khi cấu hình tool.';
  }
  return null;
}

export function registerToolRoutes(app: FastifyInstance): void {
  const home = () => process.env.AGY_TEST_HOME || homedir();

  app.get('/api/tools', async () => {
    const u = baseUrls();
    return {
      baseUrl: u,
      apiKey: config.gateway.apiKey,
      defaultModel: config.gateway.anthropicBigModel,
      warning: guardOpenRelay(),
      tools: TOOL_IDS.map((id) => toolStatus(id, home())),
    };
  });

  app.post('/api/tools/:id/preview', async (req, reply) => {
    const { id } = req.params as { id: ToolId };
    if (!TOOLS[id]) return reply.code(404).send({ ok: false, error: 'tool không tồn tại' });
    try {
      return { ok: true, ...previewTool(id, valuesFrom(req.body), home(), (req.body as any)?.overwrite === true) };
    } catch (e: any) {
      return reply.code(e instanceof ToolWriteError ? 400 : 500).send({ ok: false, error: e.message });
    }
  });

  app.post('/api/tools/:id/apply', async (req, reply) => {
    const { id } = req.params as { id: ToolId };
    if (!TOOLS[id]) return reply.code(404).send({ ok: false, error: 'tool không tồn tại' });
    const warn = guardOpenRelay();
    if (warn && (req.body as any)?.force !== true) return reply.code(400).send({ ok: false, error: warn });
    try {
      const v = valuesFrom(req.body);
      const r = applyTool(id, v, home(), (req.body as any)?.overwrite === true);
      emitLog({ runId: 0, email: '-', flow: 'tools', level: 'info', msg: `Cấu hình ${TOOLS[id].label} → ${r.path} (model ${v.model})${r.backup ? ` · backup ${r.backup.split('/').pop()}` : ''}` });
      return { ok: true, ...r, model: v.model };
    } catch (e: any) {
      return reply.code(e instanceof ToolWriteError ? 400 : 500).send({ ok: false, error: e.message });
    }
  });

  app.post('/api/tools/:id/undo', async (req, reply) => {
    const { id } = req.params as { id: ToolId };
    if (!TOOLS[id]) return reply.code(404).send({ ok: false, error: 'tool không tồn tại' });
    try {
      const r = undoTool(id, home());
      emitLog({ runId: 0, email: '-', flow: 'tools', level: 'info', msg: `Gỡ cấu hình ${TOOLS[id].label}: ${r.detail}` });
      return { ok: r.restored, ...r };
    } catch (e: any) {
      return reply.code(e instanceof ToolWriteError ? 400 : 500).send({ ok: false, error: e.message });
    }
  });
}
