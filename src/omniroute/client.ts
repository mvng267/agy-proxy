import { config } from '../config.js';

/**
 * Client cho OmniRoute (schema đã capture trực tiếp từ instance đang chạy).
 *  - Auth bằng session cookie (POST /api/auth/login {password}).
 *  - Providers = "connections": GET/POST /api/providers, DELETE/:id, POST /:id/test.
 *  - OAuth: GET /api/oauth/:provider/authorize, POST /:provider/exchange, /:provider/poll.
 */

export interface OmniConnection {
  id: string;
  provider: string;
  authType: string;
  name: string;
  priority: number;
  isActive: boolean;
  testStatus: string;
  apiKey?: string;
  proxyEnabled?: boolean;
  createdAt?: string;
}

export interface OAuthAuthorize {
  authUrl: string | null;
  state: string;
  codeVerifier: string;
  codeChallenge?: string;
  redirectUri: string;
  flowType: string; // 'authorization-code' | 'device_code' | ...
  callbackPath?: string;
}

class OmniRouteClient {
  private cookie = '';
  private authed = false;

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...extra };
    if (this.cookie) h['cookie'] = this.cookie;
    return h;
  }

  private mergeCookies(res: Response): void {
    // undici (Node 22) hỗ trợ getSetCookie()
    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (setCookies.length === 0) return;
    const jar = new Map<string, string>();
    // giữ cookie cũ
    for (const part of this.cookie.split(';')) {
      const t = part.trim();
      if (!t) continue;
      const eq = t.indexOf('=');
      if (eq > 0) jar.set(t.slice(0, eq), t.slice(eq + 1));
    }
    for (const sc of setCookies) {
      const first = sc.split(';')[0]?.trim() ?? '';
      const eq = first.indexOf('=');
      if (eq > 0) jar.set(first.slice(0, eq), first.slice(eq + 1));
    }
    this.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private url(path: string): string {
    return config.omniroute.url + path;
  }

  async status(): Promise<{ authenticated: boolean }> {
    const res = await fetch(this.url('/api/auth/status'), { headers: this.headers() });
    if (!res.ok) return { authenticated: false };
    return (await res.json()) as { authenticated: boolean };
  }

  async login(): Promise<void> {
    if (!config.omniroute.password) {
      throw new Error('OMNIROUTE_PASSWORD chưa cấu hình trong .env');
    }
    const res = await fetch(this.url('/api/auth/login'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ password: config.omniroute.password }),
    });
    this.mergeCookies(res);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || body.success !== true) {
      throw new Error(`OmniRoute login thất bại: ${res.status} ${JSON.stringify(body)}`);
    }
    this.authed = true;
  }

  async ensureAuth(): Promise<void> {
    if (this.authed) {
      const s = await this.status();
      if (s.authenticated) return;
      this.authed = false;
    }
    await this.login();
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensureAuth();
    const res = await fetch(this.url(path), {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.mergeCookies(res);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg =
        (json as { error?: { message?: string } | string })?.error ?? `HTTP ${res.status}`;
      throw new Error(
        `OmniRoute ${method} ${path} -> ${res.status}: ${
          typeof msg === 'string' ? msg : JSON.stringify(msg)
        }`,
      );
    }
    return json as T;
  }

  // ---- connections ----
  async listConnections(): Promise<OmniConnection[]> {
    const r = await this.req<{ connections: OmniConnection[] }>('GET', '/api/providers');
    return r.connections ?? [];
  }

  async createConnection(input: {
    provider: string;
    name: string;
    apiKey: string;
    priority?: number;
    proxyEnabled?: boolean;
  }): Promise<OmniConnection> {
    const r = await this.req<{ connection: OmniConnection }>('POST', '/api/providers', input);
    return r.connection;
  }

  async deleteConnection(id: string): Promise<void> {
    await this.req('DELETE', `/api/providers/${id}`);
  }

  async testConnection(id: string): Promise<unknown> {
    return this.req('POST', `/api/providers/${id}/test`);
  }

  /** Tìm connection theo provider + name (idempotent khi chạy lại). */
  async findConnection(provider: string, name: string): Promise<OmniConnection | undefined> {
    const list = await this.listConnections();
    return list.find((c) => c.provider === provider && c.name === name);
  }

  // ---- oauth ----
  async oauthAuthorize(provider: string): Promise<OAuthAuthorize> {
    return this.req<OAuthAuthorize>('GET', `/api/oauth/${provider}/authorize`);
  }

  async oauthExchange(
    provider: string,
    input: { code: string; state: string; codeVerifier: string; redirectUri: string },
  ): Promise<unknown> {
    return this.req('POST', `/api/oauth/${provider}/exchange`, input);
  }

  async oauthPoll(provider: string, deviceCode: string): Promise<unknown> {
    return this.req('POST', `/api/oauth/${provider}/poll`, { deviceCode });
  }

  /** Import token trực tiếp (vd Kiro: dán refreshToken lấy từ luồng PKCE). */
  async oauthImport(provider: string, body: Record<string, unknown>): Promise<unknown> {
    return this.req('POST', `/api/oauth/${provider}/import`, body);
  }

  // ---- models + chat test ----
  private apiKey = '';

  async listModels(): Promise<
    { provider: string; model: string; fullModel: string; name: string; available: boolean }[]
  > {
    const r = await this.req<{ data?: unknown; models?: unknown }>('GET', '/api/models');
    const arr = (r.data ?? r.models ?? r) as Array<Record<string, unknown>>;
    return (Array.isArray(arr) ? arr : []).map((m) => ({
      provider: String(m.provider ?? ''),
      model: String(m.model ?? m.alias ?? ''),
      fullModel: String(m.fullModel ?? `${m.provider}/${m.model}`),
      name: String(m.name ?? m.model ?? ''),
      available: m.available !== false,
    }));
  }

  /** Tạo (hoặc tái dùng) 1 API key để gọi /v1 cho chức năng chat test. */
  async ensureApiKey(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const r = await this.req<{ key?: string }>('POST', '/api/keys', { name: 'dashboard-chat-test' });
    this.apiKey = r.key ?? '';
    return this.apiKey;
  }

  async chat(model: string, content: string): Promise<{ ok: boolean; text?: string; error?: string }> {
    const key = await this.ensureApiKey();
    const res = await fetch(this.url('/v1/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        stream: false,
      }),
    });
    const j = (await res.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string } | string;
    };
    if (res.ok && j.choices?.[0]?.message?.content !== undefined) {
      return { ok: true, text: j.choices[0].message!.content };
    }
    const err = typeof j.error === 'string' ? j.error : (j.error?.message ?? `HTTP ${res.status}`);
    return { ok: false, error: err };
  }
}

export const omniroute = new OmniRouteClient();
