import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Danh mục CLI tool cấu hình được 1 chạm.
 * `home` luôn TRUYỀN VÀO (không gọi os.homedir() bên trong) để test không đụng home thật.
 */

export type ToolId = 'claude' | 'claude-profile' | 'opencode' | 'gemini' | 'codex' | 'hermes' | 'antigravity';
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
  /** Có thì tool này KHÔNG hỗ trợ endpoint tuỳ chỉnh — UI cảnh báo trước khi ghi. */
  unsupported?: string;
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
  opencode: {
    id: 'opencode',
    label: 'opencode',
    format: 'json',
    api: 'openai',
    configPath: (home) => resolve(home, '.config/opencode/opencode.json'),
    detect: (home) => ({ installed: existsSync(resolve(home, '.config/opencode')), via: 'dir ~/.config/opencode' }),
    // opencode dùng khối provider riêng (ai-sdk openai-compatible), model gọi là `agyproxy/<id>`
    patch: (v) => ({
      model: `agyproxy/${v.model}`,
      small_model: `agyproxy/${v.smallModel || v.model}`,
      provider: {
        agyproxy: {
          name: 'agyproxy',
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: v.openaiBaseUrl, apiKey: v.apiKey || 'agyproxy' },
          models: Object.fromEntries(
            [...new Set([v.model, v.smallModel].filter(Boolean) as string[])].map((m) => [
              m,
              { id: m, name: m, tool_call: true, temperature: true },
            ]),
          ),
        },
      },
    }),
    notes: 'Giữ nguyên provider khác đang có (vd 9router) — chỉ thêm/ghi đè khối agyproxy.',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    format: 'env',
    api: 'openai',
    configPath: (home) => resolve(home, '.gemini/.env'),
    detect: (home) => ({ installed: existsSync(resolve(home, '.gemini')), via: 'dir ~/.gemini' }),
    patch: (v) =>
      [
        MARK_BEGIN,
        `OPENAI_BASE_URL=${v.openaiBaseUrl}`,
        `OPENAI_API_KEY=${v.apiKey || 'agyproxy'}`,
        `OPENAI_MODEL=${v.model}`,
        MARK_END,
      ].join('\n'),
    notes: 'Chạy: gemini --openai (hoặc chọn auth type OpenAI). File .env được Gemini CLI nạp tự động.',
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
    label: 'Antigravity CLI / IDE',
    format: 'env',
    api: 'openai',
    /** Antigravity CLI của Google cài ở ~/.gemini/antigravity-cli (đã kiểm chứng trên máy). */
    configPath: (home) => resolve(home, '.gemini/antigravity-cli/.env'),
    detect: (home) => ({
      installed: existsSync(resolve(home, '.gemini/antigravity-cli')),
      via: 'dir ~/.gemini/antigravity-cli',
    }),
    /**
     * KHÔNG hỗ trợ chính thức: Antigravity (cả IDE lẫn CLI của Google) không có BYOK /
     * custom endpoint. settings.json của nó chỉ chứa trustedWorkspaces, binary không đọc
     * OPENAI_BASE_URL. Ghi file này chỉ có tác dụng nếu bạn dùng bản antigravity-cli
     * cộng đồng (fork) có đọc biến môi trường.
     */
    patch: (v) =>
      [
        MARK_BEGIN,
        `OPENAI_BASE_URL=${v.openaiBaseUrl}`,
        `OPENAI_API_KEY=${v.apiKey || 'agyproxy'}`,
        `OPENAI_MODEL=${v.model}`,
        MARK_END,
      ].join('\n'),
    unsupported:
      'Antigravity bản chính thức KHÔNG hỗ trợ endpoint tuỳ chỉnh (không có BYOK). ' +
      'Chính account Antigravity của bạn đang được phục vụ qua prefix agy/ cho các tool khác — ' +
      'trỏ ngược Antigravity về đây là thừa. Mục này chỉ dùng cho bản fork cộng đồng có đọc OPENAI_BASE_URL.',
    notes: 'Chỉ ghi khi bạn dùng bản fork cộng đồng — bản Google chính thức sẽ bỏ qua file này.',
  },
};

export const TOOL_IDS = Object.keys(TOOLS) as ToolId[];
