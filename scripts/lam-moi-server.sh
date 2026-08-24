#!/usr/bin/env bash
#
# LÀM MỚI HOÀN TOÀN máy production: xoá sạch agyproxy + OmniRoute, cài lại bản mới nhất.
#
#   ssh mvng@100.112.240.4
#   cd <thư-mục-agyproxy> && bash scripts/lam-moi-server.sh
#
# ⚠ KHÁC HẲN `deploy-debian.sh`: script đó CỐ Ý không đụng `data/`. Script này XOÁ nó.
#   Chỉ dùng khi thật sự muốn bỏ toàn bộ credential cũ và bắt đầu lại.
#
# Vì sao cần: bộ account `@edmicro.vn` đã bị Google xoá — đo trên chính máy này thấy
# 18/221 sống (8%), riêng Antigravity 0/100. Giữ lại chỉ làm pool chậm vì mỗi request
# phải thử hàng loạt account chết.
#
# Chạy lại nhiều lần được. Sao lưu TRƯỚC khi xoá, và không xoá gì nếu sao lưu hỏng.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
AGY_HOME="${AGY_HOME:-$HOME/.agyproxy}"
OMNI_HOME="$HOME/.omniroute"
PORT="$(grep -oP '(?<=^PORT=)\d+' .env 2>/dev/null || echo 7788)"

xanh() { printf '\033[32m%s\033[0m\n' "$1"; }
vang() { printf '\033[33m%s\033[0m\n' "$1"; }
loi()  { printf '\033[31m%s\033[0m\n' "$1"; }

# ── 0. Điều kiện cần ─────────────────────────────────────────────────────────
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if (( NODE_MAJOR < 22 )); then
  loi "LỖI: cần Node >= 22, đang có $(node -v 2>/dev/null || echo 'không có')."
  echo "  node:sqlite (DatabaseSync) đòi >= 22.5. Debian mặc định Node 18."
  exit 1
fi
xanh "✓ Node $(node -v)"

# ── 1. Xác nhận — đây là thao tác KHÔNG ĐẢO NGƯỢC ───────────────────────────
echo
vang "════════ SẼ XOÁ SẠCH ════════"
echo "  $AGY_HOME/data       (credential, account, state.db)"
echo "  $AGY_HOME/profiles   (profile Chrome)"
echo "  $OMNI_HOME           (toàn bộ dữ liệu OmniRoute)"
echo
if [[ -d "$AGY_HOME/data" ]]; then
  echo "  Hiện có: $(ls "$AGY_HOME/data" 2>/dev/null | wc -l) tệp · $(du -sh "$AGY_HOME/data" 2>/dev/null | cut -f1)"
fi
echo
read -rp "Gõ ĐÚNG chữ 'XOA' để tiếp tục: " tra
[[ "$tra" == "XOA" ]] || { vang "Huỷ — không đụng gì."; exit 0; }

# ── 2. Dừng mọi dịch vụ ─────────────────────────────────────────────────────
vang "Dừng dịch vụ…"
if command -v systemctl >/dev/null && systemctl list-units --type=service 2>/dev/null | grep -q agyproxy; then
  sudo systemctl stop agyproxy || true
fi
command -v pm2 >/dev/null && pm2 stop agyproxy 2>/dev/null || true
pkill -f 'agyproxy|omniroute' 2>/dev/null || true
sleep 3
xanh "✓ Đã dừng"

# ── 3. Sao lưu — SAU khi dừng dịch vụ ───────────────────────────────────────
# Thứ tự này là bắt buộc: sao lưu trong lúc dịch vụ còn chạy thì `state.db-wal` và
# `profiles/` (Chrome đang mở) thay đổi giữa lúc `tar` đọc → tar trả exit code khác 0
# ("file changed as we read it") → script tưởng sao lưu hỏng và dừng. Đã bị đúng lỗi này.
#
# Backup chứa credential ở dạng đọc được → 0600, để trong $HOME.
BK="$HOME/agyproxy-truoc-khi-lam-moi-$(date +%Y%m%d-%H%M%S).tar.gz"
if [[ -d "$AGY_HOME" ]]; then
  # Exit code 1 của tar = "file đổi khi đang đọc", chấp nhận được (chỉ 2 mới là lỗi thật).
  set +e
  tar czf "$BK" -C "$HOME" .agyproxy 2>"$HOME/.tar-loi.txt"
  MA=$?
  set -e
  if (( MA > 1 )) || [[ ! -s "$BK" ]]; then
    loi "LỖI: sao lưu hỏng (tar exit $MA) — DỪNG, không xoá gì cả."
    [[ -s "$HOME/.tar-loi.txt" ]] && sed 's/^/    /' "$HOME/.tar-loi.txt" | head -5
    exit 1
  fi
  (( MA == 1 )) && vang "⚠ Vài tệp đổi khi đang đọc (bình thường) — bản sao vẫn dùng được."
  chmod 600 "$BK"
  rm -f "$HOME/.tar-loi.txt"
  xanh "✓ Sao lưu: $BK ($(du -h "$BK" | cut -f1))"
else
  vang "⚠ Chưa có $AGY_HOME — bỏ qua sao lưu."
fi

# ── 4. Xoá sạch ─────────────────────────────────────────────────────────────
rm -rf "$AGY_HOME/data" "$AGY_HOME/profiles" "$AGY_HOME/screenshots" "$OMNI_HOME"
xanh "✓ Đã xoá dữ liệu cũ"

# ── 5. Kéo mã mới + cài dependency ──────────────────────────────────────────
if [[ -d .git ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    vang "⚠ Có thay đổi chưa commit trên server → bỏ qua để tránh mất:"
    git status --short | sed 's/^/    /'
    read -rp "  Bỏ hết và lấy bản trên GitHub? (go/khong): " g
    [[ "$g" == "go" ]] && { git reset --hard; git clean -fd; }
  fi
  git fetch --quiet origin
  git pull --ff-only origin main
  xanh "✓ Mã: $(git rev-parse --short HEAD)"
fi
npm ci --omit=dev
xanh "✓ Đã cài dependency"

# ── 6. Cài OmniRoute + áp bản vá ────────────────────────────────────────────
# Vá BẮT BUỘC: Kiro free-tier cấp CHUNG một profileArn cho mọi tài khoản Google
# (đo 20/20 account đều ra profile/EHGA3GRVQMUK), nên bản gốc coi 400 account là MỘT
# và ghi đè lẫn nhau còn 1 hàng. Vá đổi sang phân biệt bằng refreshToken.
vang "Cài OmniRoute…"
npm install -g omniroute 2>&1 | tail -2
OMNI_DIR="$(npm root -g)/omniroute"
if [[ -f "$ROOT/tools/va-omniroute/va-dist.mjs" ]]; then
  node "$ROOT/tools/va-omniroute/va-dist.mjs" "$OMNI_DIR"
  xanh "✓ Đã áp bản vá dedupe-theo-refreshToken"
else
  vang "⚠ Thiếu tools/va-omniroute/va-dist.mjs — OmniRoute sẽ chỉ giữ được 1 account Kiro!"
fi

# ── 7. Khởi động ────────────────────────────────────────────────────────────
mkdir -p "$OMNI_HOME"

# OmniRoute: cài unit systemd user (không cần sudo). Đường dẫn trong unit là mặc định
# nên phải thay theo máy thật.
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
if [[ -f "$ROOT/deploy/systemd/omniroute.service" ]]; then
  cp "$ROOT/deploy/systemd/omniroute.service" "$UNIT_DIR/"
  sed -i "s#/home/mvng/.local/lib/node_modules#$(npm root -g)#g" "$UNIT_DIR/omniroute.service"
  sed -i "s#/home/mvng/.local/node/bin/node#$(command -v node)#g" "$UNIT_DIR/omniroute.service"
  sed -i "s#^User=.*#User=$USER#" "$UNIT_DIR/omniroute.service"
  sed -i "s#^WorkingDirectory=.*#WorkingDirectory=$HOME#" "$UNIT_DIR/omniroute.service"
  sed -i "s#ReadWritePaths=.*#ReadWritePaths=$OMNI_HOME#" "$UNIT_DIR/omniroute.service"
  systemctl --user daemon-reload
  systemctl --user enable --now omniroute 2>&1 | tail -1
  xanh "✓ OmniRoute chạy qua systemd"
else
  vang "⚠ Thiếu deploy/systemd/omniroute.service → chạy tạm bằng nohup (mất khi reboot)"
  nohup node "$OMNI_DIR/bin/omniroute.mjs" > "$HOME/omniroute.log" 2>&1 &
  disown
fi

# agy-proxy: CLI tự sinh unit — điền đúng AGY_HOME/PORT/đường dẫn Node, tự viết dễ lệch.
node bin/agyproxy.mjs service install 2>&1 | tail -2
xanh "✓ agy-proxy chạy qua systemd"

# Service user mặc định TẮT khi đăng xuất SSH — bật linger để nó sống tiếp.
if command -v loginctl >/dev/null; then
  if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
    vang "Bật linger để service sống khi đăng xuất SSH (cần sudo):"
    sudo loginctl enable-linger "$USER" && xanh "✓ Đã bật linger" ||       vang "⚠ Không bật được — service sẽ DỪNG khi ông thoát SSH. Chạy tay: sudo loginctl enable-linger $USER"
  fi
fi

# ── 8. Nghiệm thu — đo, không đoán ──────────────────────────────────────────
echo
vang "Chờ dịch vụ lên…"
for i in $(seq 1 30); do
  sleep 2
  curl -sf -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  [[ $i == 30 ]] && { loi "LỖI: agyproxy không lên sau 60s. Xem log."; exit 1; }
done
for i in $(seq 1 30); do
  sleep 2
  curl -sf -m 5 "http://127.0.0.1:20128/api/health/ping" >/dev/null 2>&1 && break
done

echo
xanh "═══ Nghiệm thu ═══"
curl -s "http://127.0.0.1:$PORT/api/health" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);
console.log('  agyproxy  : v'+o.version+' · accounts '+o.accounts+' · pool '+o.poolSize);})"
if curl -sf -m 5 "http://127.0.0.1:20128/api/health/ping" >/dev/null 2>&1; then
  xanh "  OmniRoute : chạy (cổng 20128)"
else
  vang "  OmniRoute : KHÔNG lên — xem $HOME/omniroute.log"
fi

echo
xanh "✓ Xong. Máy đã sạch, sẵn sàng nhận account mới."
echo "  Sao lưu bản cũ : ${BK:-'(không có)'}"
echo "  Bước tiếp theo : chuyển credential từ Mac sang (xem chuyen-account.sh)"
