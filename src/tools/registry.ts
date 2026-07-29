import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Danh mục CLI tool cấu hình được 1 chạm.
 * `home` luôn TRUYỀN VÀO (không gọi os.homedir() bên trong) để test không đụng home thật.
 */

export type ToolId = 'claude' | 'claude-profile' | 'codex' | 'hermes' | 'antigravity';
export type ToolFormat = 'json' | 'marker' | 'env';

export interface SetupValues {
  /** Base URL Anthropic — KHÔNG kèm /v1 (Claude Code tự thêm). */
  anthropicBaseUrl: string;
  /** Base URL OpenAI-compatible — CÓ /proxy/v1. */
  openaiBaseUrl: string;
  apiKey: string;
  model: string;
  smallModel?: string;
}

export interface ToolDef {
  id: ToolId;
  label: string;
  format: ToolFormat;
  /** Chuẩn API tool này nói. */
  api: 'anthropic' | 'openai';
  configPath(home: string): string;
  detect(home: string): { installed: boolean; via?: string };
  /** json → object để deep-merge; marker/env → text block. */
  patch(v: SetupValues): Record<string, unknown> | string;
  notes?: string;
}

const MARK_BEGIN = '# >>> agyproxy begin (managed) >>>';
const MARK_END = '# <<< agyproxy end <<<';
export const MARKERS = { begin: MARK_BEGIN, end: MARK_END };

function claudeEnv(v: SetupValues): Record<string, unknown> {
  return {
    env: {
      ANTHROPIC_BASE_URL: v.anthropicBaseUrl,
      ANTHROPIC_AUTH_TOKEN: v.apiKey || 'agyproxy',
      ANTHROPIC_MODEL: v.model,
      ANTHROPIC_SMALL_FAST_MODEL: v.smallModel || v.model,
    },
  };
}

export const TOOLS: Record<ToolId, ToolDef> = {
  claude: {
    id: 'claude',
    label: 'Claude Code (file gốc)',
    format: 'json',
    api: 'anthropic',
    configPath: (home) => resolve(home, '.claude/settings.json'),
    detect: (home) => ({ installed: existsSync(resolve(home, '.claude')), via: 'dir ~/.claude' }),
    patch: claudeEnv,
    notes: 'Merge vào settings.json đang dùng — MỌI phiên Claude Code sau đó sẽ đi qua gateway này.',
  },
  'claude-profile': {
    id: 'claude-profile',
    label: 'Claude Code (profile riêng)',
    format: 'json',
    api: 'anthropic',
    configPath: (home) => resolve(home, '.claude/settings.agyproxy.json'),
    detect: (home) => ({ installed: existsSync(resolve(home, '.claude')), via: 'dir ~/.claude' }),
    patch: claudeEnv,
    notes: 'KHÔNG đụng file gốc. Chạy: claude --settings ~/.claude/settings.agyproxy.json',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    format: 'marker',
    api: 'openai',
    configPath: (home) => resolve(home, '.codex/config.toml'),
    detect: (home) => ({ installed: existsSync(resolve(home, '.codex')), via: 'dir ~/.codex' }),
    patch: (v) =>
      [
        MARK_BEGIN,
        `model = "${v.model}"`,
        'model_provider = "agyproxy"',
        '',
        '[model_providers.agyproxy]',
        'name = "agyproxy"',
        `base_url = "${v.openaiBaseUrl}"`,
        'env_key = "AGYPROXY_API_KEY"',
        'wire_api = "chat"',
        MARK_END,
      ].join('\n'),
    notes: 'Codex đọc key từ biến môi trường: export AGYPROXY_API_KEY=<key>',
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes',
    format: 'env',
    api: 'openai',
    configPath: (home) => resolve(home, '.hermes/.env'),
    detect: (home) => ({ installed: existsSync(resolve(home, '.hermes')), via: 'dir ~/.hermes' }),
    patch: (v) =>
      [
        MARK_BEGIN,
        `OPENAI_BASE_URL=${v.openaiBaseUrl}`,
        `OPENAI_API_KEY=${v.apiKey || 'agyproxy'}`,
        `OPENAI_MODEL=${v.model}`,
        MARK_END,
      ].join('\n'),
    notes: 'Hermes đọc secret ở ~/.hermes/.env; model chọn thêm bằng `hermes config set model`.',
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity CLI',
    format: 'env',
    api: 'openai',
    configPath: (home) => resolve(home, '.antigravity-cli/.env'),
    detect: (home) => ({ installed: existsSync(resolve(home, '.antigravity-cli')), via: 'dir ~/.antigravity-cli' }),
    patch: (v) =>
      [
        MARK_BEGIN,
        `OPENAI_BASE_URL=${v.openaiBaseUrl}`,
        `OPENAI_API_KEY=${v.apiKey || 'agyproxy'}`,
        `OPENAI_MODEL=${v.model}`,
        MARK_END,
      ].join('\n'),
    notes: 'Antigravity IDE bản gốc KHÔNG hỗ trợ custom endpoint chính thức — mục này dành cho antigravity-cli cộng đồng.',
  },
};

export const TOOL_IDS = Object.keys(TOOLS) as ToolId[];
