#!/usr/bin/env bash
# Deploy backend: sync source lên server, npm ci, rồi restart qua pm2/systemd nếu có.
# Backend chạy trực tiếp bằng tsx (không có bước build riêng).
#
# Env (không hardcode host/path):
#   DEPLOY_HOST   bắt buộc — ssh target, vd: deploy@1.2.3.4 hoặc alias trong ~/.ssh/config
#   DEPLOY_PATH   bắt buộc — thư mục app trên server, vd: /opt/agy-proxy
#   DEPLOY_PORT   tuỳ chọn — cổng ssh (mặc định 22)
#   SKIP_INSTALL=1  tuỳ chọn — bỏ qua npm ci trên server
#
# Cách dùng:
#   DEPLOY_HOST=deploy@server DEPLOY_PATH=/opt/agy-proxy scripts/deploy-backend.sh
#   scripts/deploy-backend.sh --dry-run   # in các lệnh sẽ chạy, không đẩy gì
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

DEPLOY_PORT="${DEPLOY_PORT:-22}"
if [[ -z "${DEPLOY_HOST:-}" || -z "${DEPLOY_PATH:-}" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "==> DRY RUN: thiếu DEPLOY_HOST/DEPLOY_PATH — dùng placeholder để in lệnh"
    DEPLOY_HOST="${DEPLOY_HOST:-<user@host>}"
    DEPLOY_PATH="${DEPLOY_PATH:-</path/to/agy-proxy>}"
  else
    echo "LỖI: cần export DEPLOY_HOST và DEPLOY_PATH (xem README mục Deployment)" >&2
    exit 1
  fi
fi

command -v rsync >/dev/null 2>&1 || { echo "LỖI: deploy backend cần rsync (nhiều file, cần exclude)" >&2; exit 1; }

# 1) Sync source. KHÔNG đụng data/ profiles/ .env trên server — đó là state sống còn.
SYNC=(rsync -az --delete -e "ssh -p $DEPLOY_PORT"
  --exclude node_modules --exclude .git --exclude data --exclude profiles
  --exclude screenshots --exclude .env --exclude '*.log' --exclude web/node_modules
  "$ROOT/" "$DEPLOY_HOST:$DEPLOY_PATH/")

# 2) Cài deps + restart trên server: ưu tiên pm2, rồi systemd, còn lại in hướng dẫn.
REMOTE=$(cat <<'EOF'
set -euo pipefail
cd "$DEPLOY_PATH"
if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  echo "==> npm ci --omit=dev"
  npm ci --omit=dev
fi
if command -v pm2 >/dev/null 2>&1; then
  echo "==> Restart qua pm2"
  pm2 restart agy-proxy 2>/dev/null || pm2 start npm --name agy-proxy -- start
  pm2 save
elif systemctl list-unit-files agy-proxy.service --no-legend 2>/dev/null | grep -q agy-proxy; then
  echo "==> Restart qua systemd"
  sudo systemctl restart agy-proxy
else
  echo "==> Không thấy pm2/systemd service. Chạy tay: cd $DEPLOY_PATH && npm start"
  echo "    (Xem README mục Deployment để cài pm2 hoặc tạo systemd unit.)"
fi
EOF
)

if [[ "$DRY_RUN" == "1" ]]; then
  echo "==> DRY RUN — lệnh sync sẽ chạy:"
  printf '    %q ' "${SYNC[@]}"; echo
  echo "==> DRY RUN — script chạy trên server (qua ssh):"
  echo "$REMOTE" | sed 's/^/    /'
  exit 0
fi

echo "==> Sync source → $DEPLOY_HOST:$DEPLOY_PATH"
ssh -p "$DEPLOY_PORT" "$DEPLOY_HOST" "mkdir -p '$DEPLOY_PATH'"
"${SYNC[@]}"

echo "==> Cài deps + restart trên server"
ssh -p "$DEPLOY_PORT" "$DEPLOY_HOST" "DEPLOY_PATH='$DEPLOY_PATH' SKIP_INSTALL='${SKIP_INSTALL:-0}' bash -s" <<<"$REMOTE"
echo "==> Xong."
