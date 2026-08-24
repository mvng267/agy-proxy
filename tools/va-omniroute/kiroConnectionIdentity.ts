export type KiroConnectionLike = {
  id?: unknown;
  authType?: unknown;
  refreshToken?: unknown;
  name?: unknown;
  email?: unknown;
  providerSpecificData?: unknown;
  [key: string]: unknown;
};

export type KiroConnectionIdentity = {
  authType?: unknown;
  refreshToken?: unknown;
  profileArn?: unknown;
  clientId?: unknown;
  email?: unknown;
  name?: unknown;
};

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function folded(value: unknown): string {
  return trimmed(value).toLowerCase();
}

function providerData(connection: KiroConnectionLike): Record<string, unknown> {
  const value = connection.providerSpecificData;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Find an existing Kiro account without comparing OAuth tokens or API keys. */
export function findKiroConnectionByIdentity(
  connections: KiroConnectionLike[],
  identity: KiroConnectionIdentity
): KiroConnectionLike | null {
  const authType = folded(identity.authType);
  const candidates = authType
    ? connections.filter((connection) => folded(connection.authType) === authType)
    : connections;

  // refreshToken là thứ DUY NHẤT thật sự riêng cho từng tài khoản.
  //
  // Kiro free-tier cấp CHUNG một profileArn cho mọi tài khoản Google — đo trên 20 tài khoản
  // khác nhau đều ra `arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK`.
  // Khớp profileArn trước nghĩa là tài khoản thứ hai trở đi đè lên hàng của tài khoản đầu,
  // nên không pool được nhiều tài khoản Kiro: import 20 lần, API báo thành công 20 lần, mà
  // bảng chỉ còn 1 hàng.
  //
  // Kiểm refreshToken trước sửa đúng chỗ đó, và vẫn giữ nguyên hành vi cũ cho mọi trường
  // hợp một-tài-khoản (cùng token ⇒ vẫn khớp đúng hàng cũ, vẫn là cập nhật chứ không thêm).
  const refreshToken = trimmed(identity.refreshToken);
  if (refreshToken) {
    const match = candidates.find(
      (connection) =>
        trimmed(connection.refreshToken) === refreshToken ||
        trimmed(providerData(connection).refreshToken) === refreshToken
    );
    if (match) return match;
    // Có token mà không hàng nào khớp ⇒ tài khoản MỚI. Không được rơi xuống profileArn,
    // vì ARN dùng chung sẽ khớp nhầm sang tài khoản khác.
    return null;
  }

  const profileArn = trimmed(identity.profileArn);
  if (profileArn) {
    const match = candidates.find(
      (connection) => trimmed(providerData(connection).profileArn) === profileArn
    );
    if (match) return match;
  }

  const clientId = trimmed(identity.clientId);
  if (clientId) {
    const match = candidates.find(
      (connection) => trimmed(providerData(connection).clientId) === clientId
    );
    if (match) return match;
  }

  const email = folded(identity.email);
  if (email) {
    const match = candidates.find((connection) => folded(connection.email) === email);
    if (match) return match;
  }

  const name = folded(identity.name);
  if (name) {
    const match = candidates.find((connection) => folded(connection.name) === name);
    if (match) return match;
  }

  return null;
}
