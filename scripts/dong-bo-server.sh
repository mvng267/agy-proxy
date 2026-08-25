#!/usr/bin/env bash
#
# Đẩy credential từ agy-proxy sang OmniRoute — CHẠY TRÊN SERVER.
#
#   cd ~/agy-proxy && bash scripts/dong-bo-server.sh
#
# Vì sao không copy thẳng `storage.sqlite` từ máy khác: token trong đó mã hoá bằng
# `STORAGE_ENCRYPTION_KEY`, mỗi máy một khoá riêng (OmniRoute tự sinh lần đầu chạy).
# Copy DB mà không copy khoá thì connection hiện xanh nhưng giải mã token nào cũng hỏng.
# Đẩy qua API để OmniRoute tự mã hoá bằng khoá của CHÍNH nó.
#
# Chạy lại nhiều lần được.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

xanh() { printf '\033[32m%s\033[0m\n' "$1"; }
vang() { printf '\033[33m%s\033[0m\n' "$1"; }
loi()  { printf '\033[31m%s\033[0m\n' "$1"; }

MK="${OMNIROUTE_PASSWORD:-CHANGEME}"
OMNI="${OMNIROUTE_URL:-http://localhost:20128}"

# ── 1. OmniRoute có sống không ───────────────────────────────────────────────
if ! curl -sf -m 10 "$OMNI/api/health/ping" >/dev/null 2>&1; then
  loi "LỖI: OmniRoute không phản hồi ở $OMNI"
  echo "  systemctl --user status omniroute --no-pager -l | head -12"
  exit 1
fi
xanh "✓ OmniRoute sống"

# ── 2. Bản vá dedupe — BẮT BUỘC ─────────────────────────────────────────────
# Kiro free-tier cấp CHUNG một profileArn cho mọi tài khoản Google, nên bản gốc coi
# 694 credential là MỘT và ghi đè lẫn nhau còn 1 hàng. Nó IM LẶNG: API trả success
# cả 694 lần, dashboard xanh, gọi model vẫn ra kết quả.
OMNI_DIR="$(npm root -g)/omniroute"
if ! node tools/va-omniroute/va-dist.mjs --xem "$OMNI_DIR" >/dev/null 2>&1; then
  vang "Bản vá chưa áp → đang vá…"
  node tools/va-omniroute/va-dist.mjs "$OMNI_DIR"
  systemctl --user restart omniroute 2>/dev/null || true
  vang "Chờ OmniRoute lên lại…"
  for i in $(seq 1 20); do
    sleep 3
    curl -sf -m 5 "$OMNI/api/health/ping" >/dev/null 2>&1 && break
    [[ $i == 20 ]] && { loi "OmniRoute không lên sau khi vá."; exit 1; }
  done
fi
node tools/va-omniroute/va-dist.mjs --xem "$OMNI_DIR" | sed 's/^/  /'

# ── 3. Đặt mật khẩu OmniRoute vào cấu hình agy-proxy ────────────────────────
# `dongBo()` tự tắt khi mật khẩu rỗng — đó là cổng duy nhất quyết định có gọi mạng.
node bin/agyproxy.mjs api PATCH /api/settings "{\"omniroutePassword\":\"$MK\",\"omnirouteUrl\":\"$OMNI\"}" >/dev/null 2>&1 \
  && xanh "✓ Đã đặt mật khẩu OmniRoute" \
  || vang "⚠ Không đặt được qua API (server chưa chạy?) — script vẫn thử đồng bộ"

# ── 4. Đồng bộ ──────────────────────────────────────────────────────────────
vang "Đẩy credential sang OmniRoute (Kiro gọi lẻ từng cái, mất vài phút)…"
OMNIROUTE_PASSWORD="$MK" OMNIROUTE_URL="$OMNI" npx tsx scripts/dong-bo-omniroute.mts

# ── 5. Nghiệm thu — đếm thật, không tin báo cáo ─────────────────────────────
echo
xanh "═══ Nghiệm thu ═══"
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.HOME + '/.omniroute/storage.sqlite', { readOnly: true });
const r = db.prepare(\"SELECT provider, COUNT(*) c, COUNT(DISTINCT COALESCE(name,email)) d FROM provider_connections WHERE provider IN ('antigravity','kiro','agy') GROUP BY provider\").all();
for (const x of r) console.log('  ' + x.provider + ': ' + x.c + ' connection / ' + x.d + ' tên riêng');
if (!r.length) console.log('  (chưa có connection nào — xem log phía trên)');
" 2>/dev/null | grep -v Experimental
