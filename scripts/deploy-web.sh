#!/usr/bin/env bash
# Deploy web dashboard: build web/ rồi sync dist/ lên server (rsync, fallback scp).
#
# Env (không hardcode host/path — export hoặc bỏ vào .env.deploy rồi `source`):
#   DEPLOY_HOST      bắt buộc — ssh target, vd: deploy@1.2.3.4 hoặc alias trong ~/.ssh/config
#   DEPLOY_WEB_PATH  bắt buộc — thư mục đích trên server, vd: /opt/agy-proxy/web/dist
#   DEPLOY_PORT      tuỳ chọn — cổng ssh (mặc định 22)
#   SKIP_BUILD=1     tuỳ chọn — bỏ qua bước build, chỉ sync dist/ sẵn có
#
# Cách dùng:
#   DEPLOY_HOST=deploy@server DEPLOY_WEB_PATH=/opt/agy-proxy/web/dist scripts/deploy-web.sh
#   scripts/deploy-web.sh --dry-run   # build + in lệnh sync, không đẩy gì lên server
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/web/dist"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# 1) Build
if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
  echo "==> SKIP_BUILD=1 — dùng web/dist sẵn có"
else
  echo "==> Build web dashboard"
  (cd "$ROOT/web" && npm run build)
fi
[[ -f "$DIST/index.html" ]] || { echo "LỖI: $DIST/index.html không tồn tại — build hỏng?" >&2; exit 1; }

# 2) Kiểm tra env
DEPLOY_PORT="${DEPLOY_PORT:-22}"
if [[ -z "${DEPLOY_HOST:-}" || -z "${DEPLOY_WEB_PATH:-}" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "==> DRY RUN: thiếu DEPLOY_HOST/DEPLOY_WEB_PATH — dùng placeholder để in lệnh"
    DEPLOY_HOST="${DEPLOY_HOST:-<user@host>}"
    DEPLOY_WEB_PATH="${DEPLOY_WEB_PATH:-</path/to/agy-proxy/web/dist>}"
  else
    echo "LỖI: cần export DEPLOY_HOST và DEPLOY_WEB_PATH (xem README mục Deployment)" >&2
    exit 1
  fi
fi

# 3) Sync
if command -v rsync >/dev/null 2>&1; then
  CMD=(rsync -az --delete -e "ssh -p $DEPLOY_PORT" "$DIST/" "$DEPLOY_HOST:$DEPLOY_WEB_PATH/")
else
  echo "==> Không có rsync, fallback scp (không xoá file cũ trên server)"
  CMD=(scp -P "$DEPLOY_PORT" -r "$DIST/." "$DEPLOY_HOST:$DEPLOY_WEB_PATH/")
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "==> DRY RUN — lệnh sẽ chạy:"
  printf '    %q ' "${CMD[@]}"; echo
  exit 0
fi

echo "==> Sync $DIST → $DEPLOY_HOST:$DEPLOY_WEB_PATH"
ssh -p "$DEPLOY_PORT" "$DEPLOY_HOST" "mkdir -p '$DEPLOY_WEB_PATH'"
"${CMD[@]}"
echo "==> Xong. Dashboard được backend serve tĩnh từ web/dist — không cần restart."
