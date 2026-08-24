#!/usr/bin/env bash
#
# Chuyển credential từ máy Mac sang server production. CHẠY TRÊN MÁY MAC.
#
#   bash scripts/chuyen-account.sh [user@may-chu]
#
# Vì sao chỉ chuyển `data/` mà không chuyển `profiles/`:
#   - `data/` (accounts.csv + credentials.csv) là thứ DUY NHẤT cần — token dùng được ngay,
#     không phải đăng nhập lại, không tốn lượt trong trần login/24h.
#   - `profiles/` là user-data Chrome, hàng GB, và gắn với máy sinh ra nó. Chuyển sang chỉ
#     tổ nặng; server tự tạo mới khi cần đăng nhập.
#   - `state.db` KHÔNG chuyển: nó chứa log/quota/metrics của máy Mac, trộn vào production
#     làm bẩn số liệu. Server tự tạo DB mới.
#
# Chạy lại nhiều lần được. Server sẽ MERGE chứ không ghi đè — `upsertCredential` khoá theo
# `(email, target)`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
MAY="${1:-mvng@100.112.240.4}"
AGY_HOME="${AGY_HOME:-$HOME/.agyproxy}"

xanh() { printf '\033[32m%s\033[0m\n' "$1"; }
vang() { printf '\033[33m%s\033[0m\n' "$1"; }
loi()  { printf '\033[31m%s\033[0m\n' "$1"; }

[[ -f "$AGY_HOME/data/credentials.csv" ]] || { loi "LỖI: không thấy $AGY_HOME/data/credentials.csv"; exit 1; }

# ── Đếm thứ sắp chuyển ──────────────────────────────────────────────────────
echo
xanh "═══ Sẽ chuyển ═══"
node "$(dirname "${BASH_SOURCE[0]}")/dem-credential.mjs" "$AGY_HOME/data/credentials.csv" || vang "  (không đếm được, vẫn chuyển)"

echo
read -rp "Chuyển sang $MAY? (go/khong): " tra
[[ "$tra" == "go" ]] || { vang "Huỷ."; exit 0; }

# ── Chuyển ──────────────────────────────────────────────────────────────────
# `--ignore-existing` KHÔNG dùng: muốn token mới đè token cũ trên server.
vang "Đang chuyển…"
ssh "$MAY" 'mkdir -p ~/.agyproxy/data'
rsync -avz --progress \
  "$AGY_HOME/data/accounts.csv" \
  "$AGY_HOME/data/credentials.csv" \
  "$MAY:~/.agyproxy/data/"
xanh "✓ Đã chuyển"

echo
vang "Trên server, chạy tiếp:"
echo "    node bin/agyproxy.mjs restart"
echo "    curl -s localhost:7788/api/health   # kiểm pool đã nạp"
echo
echo "  Rồi đồng bộ sang OmniRoute:"
echo "    npx tsx scripts/dong-bo-omniroute.mts"
