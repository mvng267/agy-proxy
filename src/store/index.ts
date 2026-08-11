import { CSV } from '../config.js';
import { readCsvFile, writeCsvFile } from './csv.js';
import {
  Account,
  ACCOUNT_HEADERS,
  Proxy,
  PROXY_HEADERS,
  Credential,
  CREDENTIAL_HEADERS,
  TargetStatus,
  FLOW_KEYS,
  statusField,
} from './models.js';

/**
 * Store dựa trên CSV: nạp vào memory khi khởi động, mọi thay đổi ghi lại CSV
 * nguyên tử. CSV là nguồn sự thật để backup/portable theo yêu cầu.
 */

const TIMEZONES = [
  'Asia/Ho_Chi_Minh',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Kuala_Lumpur',
  'Asia/Jakarta',
  'Asia/Manila',
];

function pick<T>(arr: T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return arr[h % arr.length]!;
}

function defaultAccount(email: string): Account {
  return {
    email,
    password: '',
    totp_secret: '',
    proxy: '',
    profile_dir: email.replace(/[^a-zA-Z0-9._-]/g, '_'),
    tz: pick(TIMEZONES, email),
    locale: 'en-US',
    status_google: 'new',
    status_gweb: 'new',
    status_agy: 'new',
    status_agycli: 'new',
    status_gcli: 'new',
    status_kiro: 'new',
    status_nous: 'new',
    last_run: '',
    note: '',
    fingerprint: '',
  };
}

function coerceStatus(v: string): TargetStatus {
  const ok: TargetStatus[] = ['new', 'ok', 'failed', 'needs_human', 'running'];
  return (ok as string[]).includes(v) ? (v as TargetStatus) : 'new';
}

class Store {
  private accounts = new Map<string, Account>();
  private proxies = new Map<string, Proxy>();
  private credentials: Credential[] = [];

  load(): void {
    this.loadAccounts();
    this.loadProxies();
    this.loadCredentials();
  }

  private loadAccounts(): void {
    const { rows } = readCsvFile(CSV.accounts);
    this.accounts.clear();
    for (const r of rows) {
      if (!r.email) continue;
      const base = defaultAccount(r.email);
      const acc: Account = { ...base };
      for (const h of ACCOUNT_HEADERS) {
        const val = r[h];
        if (val !== undefined && val !== '')
          (acc as unknown as Record<string, string>)[h] = val;
      }
      for (const f of FLOW_KEYS) {
        const key = statusField(f);
        acc[key] = coerceStatus(acc[key] as string) as never;
      }
      this.accounts.set(acc.email, acc);
    }
  }

  private loadProxies(): void {
    const { rows } = readCsvFile(CSV.proxies);
    this.proxies.clear();
    for (const r of rows) {
      if (!r.host || !r.port) continue;
      const label = r.label || `${r.host}:${r.port}`;
      this.proxies.set(label, {
        label,
        host: r.host,
        port: r.port,
        username: r.username ?? '',
        password: r.password ?? '',
        country: r.country ?? '',
      });
    }
  }

  private loadCredentials(): void {
    const { rows } = readCsvFile(CSV.credentials);
    this.credentials = rows
      .filter((r) => r.email && r.target)
      .map((r) => ({
        email: r.email!,
        target: r.target!,
        value: r.value ?? '',
        expires_at: r.expires_at ?? '',
        omniroute_connection_id: r.omniroute_connection_id ?? '',
        updated_at: r.updated_at ?? '',
        health: r.health ?? 'unknown',
        checked_at: r.checked_at ?? '',
      }));
  }

  // ---- persist ----
  saveAccounts(): void {
    writeCsvFile(
      CSV.accounts,
      ACCOUNT_HEADERS as string[],
      [...this.accounts.values()].map((a) => ({ ...a }) as unknown as Record<string, string>),
    );
  }
  saveProxies(): void {
    writeCsvFile(
      CSV.proxies,
      PROXY_HEADERS as string[],
      [...this.proxies.values()].map((p) => p as unknown as Record<string, string>),
    );
  }
  saveCredentials(): void {
    writeCsvFile(
      CSV.credentials,
      CREDENTIAL_HEADERS as string[],
      this.credentials.map((c) => c as unknown as Record<string, string>),
    );
  }

  // ---- accounts ----
  listAccounts(): Account[] {
    return [...this.accounts.values()];
  }
  getAccount(email: string): Account | undefined {
    return this.accounts.get(email);
  }
  upsertAccount(partial: Partial<Account> & { email: string }): Account {
    const existing = this.accounts.get(partial.email);
    const acc = existing ? { ...existing } : defaultAccount(partial.email);
    for (const [k, v] of Object.entries(partial)) {
      if (v !== undefined) (acc as unknown as Record<string, unknown>)[k] = v;
    }
    this.accounts.set(acc.email, acc);
    this.saveAccounts();
    return acc;
  }
  deleteAccount(email: string): void {
    this.accounts.delete(email);
    this.saveAccounts();
  }
  /** Thay toàn bộ account (giữ nguyên field/timestamp) — cho restore backup. */
  replaceAccounts(list: Partial<Account>[]): void {
    this.accounts.clear();
    for (const a of list) {
      if (!a.email) continue;
      const acc = { ...defaultAccount(a.email), ...a } as Account;
      this.accounts.set(acc.email, acc);
    }
    this.saveAccounts();
  }
  setStatus(email: string, flow: (typeof FLOW_KEYS)[number], status: TargetStatus): void {
    const acc = this.accounts.get(email);
    if (!acc) return;
    acc[statusField(flow)] = status as never;
    acc.last_run = new Date().toISOString();
    this.saveAccounts();
  }

  // ---- proxies ----
  listProxies(): Proxy[] {
    return [...this.proxies.values()];
  }
  getProxy(label: string): Proxy | undefined {
    return this.proxies.get(label);
  }
  upsertProxy(p: Proxy): void {
    this.proxies.set(p.label, p);
    this.saveProxies();
  }
  deleteProxy(label: string): void {
    this.proxies.delete(label);
    this.saveProxies();
  }
  replaceProxies(list: Proxy[]): void {
    this.proxies.clear();
    for (const p of list) this.proxies.set(p.label, p);
    this.saveProxies();
  }

  // ---- credentials ----
  listCredentials(): Credential[] {
    return this.credentials;
  }
  getCredentials(email: string): Credential[] {
    return this.credentials.filter((c) => c.email === email);
  }
  upsertCredential(
    input: Omit<Credential, 'health' | 'checked_at'> & Partial<Pick<Credential, 'health' | 'checked_at'>>,
  ): void {
    const idx = this.credentials.findIndex((x) => x.email === input.email && x.target === input.target);
    const prev = idx >= 0 ? this.credentials[idx]! : undefined;
    const c: Credential = {
      ...input,
      updated_at: new Date().toISOString(),
      health: input.health ?? prev?.health ?? 'unknown',
      checked_at: input.checked_at ?? prev?.checked_at ?? '',
    };
    if (idx >= 0) this.credentials[idx] = c;
    else this.credentials.push(c);
    this.saveCredentials();
  }
  /** Thay toàn bộ credential (giữ nguyên field/timestamp) — cho restore backup. */
  replaceCredentials(list: Credential[]): void {
    this.credentials = list.map((c) => ({ ...c }));
    this.saveCredentials();
  }

  setCredentialHealth(email: string, target: string, health: string): void {
    const c = this.credentials.find((x) => x.email === email && x.target === target);
    if (!c) return;
    c.health = health;
    c.checked_at = new Date().toISOString();
    this.saveCredentials();
  }
}

export const store = new Store();
