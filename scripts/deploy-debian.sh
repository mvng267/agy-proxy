#!/usr/bin/env bash
#
# Deploy agyproxy lên máy production Debian — CHẠY TRÊN CHÍNH MÁY ĐÓ.
#
#   ssh <user>@<may-chu>
#   cd <thư-mục-agyproxy> && bash scripts/deploy-debian.sh
#
# Vì sao git pull chứ không rsync: bản cài production là git checkout, và nút "Cập nhật"
# trên dashboard cũng chạy `git pull`. Dùng rsync sẽ làm cây làm việc lệch khỏi git,
# lần sau bấm nút Cập nhật là xung đột.
#
# Chạy lại nhiều lần được (idempotent). Không đụng data/ profiles/ .env — đó là state
# sống còn: 700 credential, token, hạn mức, cấu hình.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

xanh() { printf '\033[32m%s\033[0m\n' "$1"; }
vang() { printf '\033[33m%s\033[0m\n' "$1"; }
loi() { printf '\033[31m%s\033[0m\n' "$1"; }

# ── 0. Điều kiện cần ────────────────────────────────────────────────────────
[[ -d .git ]] || { loi "LỖI: $ROOT không phải git checkout — script này chỉ dùng cho bản cài bằng git."; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if (( NODE_MAJOR < 22 )); then
  loi "LỖI: cần Node >= 22, đang có $(node -v 2>/dev/null || echo 'không có node')."
  echo "  Debian mặc định là Node 18 — node:sqlite (DatabaseSync) đòi >= 22.5."
  echo "  Nếu đã cài Node 22 ở nơi khác thì nạp PATH trước, ví dụ:"
  echo "    export PATH=/home/\$USER/.local/node/bin:\$PATH"
  exit 1
fi
xanh "✓ Node $(node -v)"

# ── 1. Backup TRƯỚC khi đụng vào bất cứ thứ gì ──────────────────────────────
# Backup chứa toàn bộ credential và API key ở dạng đọc được → 0600 và để trong ~.
BK="$HOME/agyproxy-backup-$(date +%Y%m%d-%H%M%S).json"
PORT="$(grep -oP '(?<=^PORT=)\d+' .env 2>/dev/null || echo 7788)"
if TOK="$(node bin/agyproxy.mjs token --json 2>/dev/null | grep -o '"token":"[^"]*"' | cut -d'"' -f4)" && [[ -n "$TOK" ]]; then
  if curl -sf -u ":$TOK" "http://127.0.0.1:$PORT/api/backup/export" -o "$BK" 2>/dev/null; then
    chmod 600 "$BK"
    xanh "✓ Đã backup: $BK ($(du -h "$BK" | cut -f1))"
  else
    vang "⚠ Không gọi được API backup (server có đang chạy không?) — đi tiếp, dữ liệu trên đĩa không bị đụng."
  fi
else
  vang "⚠ Không lấy được token CLI — bỏ qua bước backup."
fi

# ── 2. Kiểm tra cây làm việc sạch ───────────────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
  loi "LỖI: có thay đổi chưa commit trên server. git pull sẽ xung đột."
  git status --short
  echo
  echo "  Muốn bỏ hết thay đổi local trên server thì chạy:  git reset --hard && git clean -fd"
  exit 1
fi

TRUOC="$(git rev-parse --short HEAD)"

# ── 3. Kéo mã mới ───────────────────────────────────────────────────────────
git fetch --quiet origin
SAU="$(git rev-parse --short origin/main)"
if [[ "$TRUOC" == "$SAU" ]]; then
  xanh "✓ Đã ở bản mới nhất ($TRUOC) — không có gì để deploy."
  exit 0
fi

echo
vang "Sẽ cập nhật: $TRUOC → $SAU"
git --no-pager log --oneline "HEAD..origin/main" | sed 's/^/    /'
echo

git pull --ff-only origin main
xanh "✓ Đã kéo mã mới"

# ── 4. Cài dependency nếu package.json đổi ──────────────────────────────────
if ! git diff --quiet "$TRUOC" HEAD -- package.json package-lock.json; then
  vang "package.json đổi → npm ci"
  npm ci --omit=dev
  xanh "✓ Đã cài dependency"
else
  xanh "✓ Dependency không đổi, bỏ qua npm ci"
fi

# web/dist được commit sẵn trong git nên KHÔNG build trên server — server chỉ cần serve.

# ── 5. Khởi động lại ────────────────────────────────────────────────────────
if command -v systemctl >/dev/null && systemctl list-units --type=service 2>/dev/null | grep -q agyproxy; then
  sudo systemctl restart agyproxy && xanh "✓ Đã restart qua systemd"
elif command -v pm2 >/dev/null && pm2 list 2>/dev/null | grep -q agyproxy; then
  pm2 restart agyproxy && xanh "✓ Đã restart qua pm2"
else
  node bin/agyproxy.mjs restart && xanh "✓ Đã restart qua CLI"
fi

# ── 6. Nghiệm thu — đo, không đoán ──────────────────────────────────────────
echo
vang "Chờ server sẵn sàng…"
for i in $(seq 1 30); do
  sleep 2
  if curl -sf -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  [[ $i == 30 ]] && { loi "LỖI: server không lên sau 60s. Xem log rồi khôi phục bằng: git reset --hard $TRUOC"; exit 1; }
done

echo
xanh "═══ Nghiệm thu ═══"
curl -s "http://127.0.0.1:$PORT/api/health" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);
console.log('  version   :', o.version);
console.log('  pool      :', o.poolSize, 'account');
console.log('  uptime    :', o.uptime + 's');})"

if [[ -n "${TOK:-}" ]]; then
  curl -s -u ":$TOK" "http://127.0.0.1:$PORT/api/overview" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);
console.log('  accounts  :', o.accounts?.total, '| gateway:', o.gateway?.total, '| cooldown:', o.gateway?.cooldown);
(o.providers||[]).forEach(p=>console.log('   ', p.id, 'ready', p.ready+'/'+p.total, '· quota TB', p.quotaAvg+'%'));})"

  # Route dialect: bản này vừa sửa lỗi routes bỏ sót 15 endpoint và /openai/* trả 401.
  echo "  route     : $(node bin/agyproxy.mjs routes --json 2>/dev/null | grep -c '"path"') endpoint"
fi

echo
xanh "✓ Deploy xong: $TRUOC → $SAU"
echo "  Backup trước khi deploy: ${BK:-'(không tạo được)'}"
echo "  Quay lại bản cũ nếu cần:  git reset --hard $TRUOC && node bin/agyproxy.mjs restart"
