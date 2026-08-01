export type FlowKey = 'google' | 'gweb' | 'agy' | 'agycli' | 'gcli' | 'kiro';

export const FLOW_KEYS: FlowKey[] = ['google', 'gweb', 'agy', 'agycli', 'gcli', 'kiro'];

export const FLOW_LABEL: Record<FlowKey, string> = {
  google: 'Google Login',
  gweb: 'Gemini Web',
  agy: 'Antigravity',
  agycli: 'Antigravity CLI',
  gcli: 'Gemini CLI',
  kiro: 'Kiro',
};

/** Trạng thái 1 target trên 1 account. */
export type TargetStatus = 'new' | 'ok' | 'failed' | 'needs_human' | 'running';

export interface Account {
  email: string;
  password: string;
  totp_secret: string;
  proxy: string; // label trỏ tới proxies.csv
  profile_dir: string; // đường dẫn tương đối trong profiles/
  tz: string; // timezone ghim cố định
  locale: string; // locale ghim cố định
  status_google: TargetStatus;
  status_gweb: TargetStatus;
  status_agy: TargetStatus;
  status_agycli: TargetStatus;
  status_gcli: TargetStatus;
  status_kiro: TargetStatus;
  last_run: string;
  note: string;
  fingerprint: string; // JSON BrowserFingerprintWithHeaders, sinh 1 lần & cố định
}

export const ACCOUNT_HEADERS: (keyof Account)[] = [
  'email',
  'password',
  'totp_secret',
  'proxy',
  'profile_dir',
  'tz',
  'locale',
  'status_google',
  'status_gweb',
  'status_agy',
  'status_agycli',
  'status_gcli',
  'status_kiro',
  'last_run',
  'note',
  'fingerprint',
];

export function statusField(flow: FlowKey): keyof Account {
  return `status_${flow}` as keyof Account;
}

export interface Proxy {
  label: string;
  host: string;
  port: string;
  username: string;
  password: string;
  country: string;
}

export const PROXY_HEADERS: (keyof Proxy)[] = [
  'label',
  'host',
  'port',
  'username',
  'password',
  'country',
];

export interface Credential {
  email: string;
  target: string; // gweb | agy | gcli | kiro
  value: string; // cookie string / refresh token / json
  expires_at: string;
  omniroute_connection_id: string;
  updated_at: string;
  health: string; // alive | dead | unknown
  checked_at: string;
}

export const CREDENTIAL_HEADERS: (keyof Credential)[] = [
  'email',
  'target',
  'value',
  'expires_at',
  'omniroute_connection_id',
  'updated_at',
  'health',
  'checked_at',
];
