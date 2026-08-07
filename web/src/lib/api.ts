/**
 * Lớp gọi API dùng chung.
 *
 * Trước đây mỗi trang tự `fetch()` trần, dẫn tới: xử lý lỗi copy-paste 12 lần,
 * `catch {}` rỗng nuốt lỗi ở 8 chỗ, và KHÔNG trang nào xử lý 401 (phiên hết hạn chỉ
 * hiện "Error: HTTP 401" giữa trang thay vì quay về đăng nhập).
 */

export class ApiError extends Error {
  // Gán tường minh thay vì parameter property — dự án bật `erasableSyntaxOnly`.
  status: number;
  body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Rút thông điệp lỗi. Backend trả tiếng Việt ở nhiều shape khác nhau — thử lần lượt. */
function messageOf(body: unknown, status: number): string {
  if (typeof body === 'string' && body) return body;
  if (body && typeof body === 'object') {
    const b = body as Record<string, any>;
    // `{error:{message}}` (OpenAI/Anthropic) → `{error:"…"}` (shape cũ) → `{message}`
    if (typeof b.error?.message === 'string') return b.error.message;
    if (typeof b.error === 'string') return b.error;
    if (typeof b.message === 'string') return b.message;
    if (typeof b.detail === 'string') return b.detail;
  }
  return `HTTP ${status}`;
}

let redirecting = false;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* không phải JSON — giữ nguyên text */
  }

  if (!res.ok) {
    // Phiên hết hạn → về trang đăng nhập. Backend đã trả {error:'unauthorized', login:'/login'}
    // nhưng UI cũ vứt đi và chỉ hiện chuỗi lỗi giữa màn hình.
    if (res.status === 401 && !redirecting) {
      redirecting = true;
      window.location.href = '/login';
    }
    throw new ApiError(res.status, messageOf(body, res.status), body);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body == null ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body == null ? undefined : JSON.stringify(body) }),
  del: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'DELETE', body: body == null ? undefined : JSON.stringify(body) }),
};
