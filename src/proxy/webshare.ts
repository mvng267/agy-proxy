import http from 'node:http';
import type { Proxy } from '../store/models.js';

/**
 * Webshare: parse list dạng `ip:port:user:pass`, tải list từ link download,
 * và test egress IP qua proxy (HTTP GET tới ip-api.com — không cần CONNECT/TLS).
 */

export function parseProxyList(text: string): Proxy[] {
  const out: Proxy[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length < 2) continue;
    const [host, port, username = '', password = ''] = parts;
    if (!host || !port) continue;
    out.push({
      label: `${host}:${port}`,
      host,
      port,
      username,
      password,
      country: '',
    });
  }
  return out;
}

export async function fetchWebshareList(url: string): Promise<Proxy[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Tải list Webshare lỗi HTTP ${res.status}`);
  const text = await res.text();
  return parseProxyList(text);
}

export interface ProxyTestResult {
  ok: boolean;
  ip?: string;
  country?: string;
  error?: string;
  ms?: number;
}

/** Test egress qua proxy bằng HTTP GET tới ip-api.com (plain HTTP, proxy forward). */
export function testProxy(proxy: Proxy, timeoutMs = 15000): Promise<ProxyTestResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const auth =
      proxy.username || proxy.password
        ? 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
        : undefined;

    const req = http.request(
      {
        host: proxy.host,
        port: Number(proxy.port),
        method: 'GET',
        path: 'http://ip-api.com/json/?fields=query,country,status',
        headers: {
          Host: 'ip-api.com',
          ...(auth ? { 'Proxy-Authorization': auth } : {}),
          'User-Agent': 'curl/8',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(body) as { query?: string; country?: string; status?: string };
            resolve({
              ok: j.status === 'success',
              ip: j.query,
              country: j.country,
              ms: Date.now() - started,
            });
          } catch {
            resolve({ ok: false, error: `Phản hồi lạ: ${body.slice(0, 120)}`, ms: Date.now() - started });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout', ms: Date.now() - started });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message, ms: Date.now() - started }));
    req.end();
  });
}
