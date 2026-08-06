#!/bin/bash
# claude-task — Chọn model/combo theo task type qua agy-proxy
# Usage: claude-task <type> [claude args...]
#   type: code | fast | research | agent | vision | <model-id> | <combo-id>
#
# Ví dụ:
#   claude-task code "refactor auth.ts"
#   claude-task fast -p "explain this"
#   claude-task kr/claude-sonnet-4.5 "hello"
#   claude-task combo/research "analyze data"

TYPE="${1:-agent}"
shift || true

# Lấy API key từ Hermes .env
API_KEY=$(grep "^HERMES_CUSTOM_LOCALHOST_7788_API_KEY=" ~/.hermes/.env | cut -d= -f2-)
BASE_URL="http://localhost:7788"

# Nếu type là model id (có /) hoặc combo id → dùng trực tiếp
# Nếu type là tên ngắn → map sang combo/
case "$TYPE" in
  code|fast|research|agent|vision)
    MODEL="combo/$TYPE"
    ;;
  combo/*)
    MODEL="$TYPE"
    ;;
  */*)
    MODEL="$TYPE"  # model id trực tiếp, vd kr/claude-sonnet-4.5
    ;;
  *)
    MODEL="combo/agent"  # default
    ;;
esac

echo "🚀 Using model: $MODEL"
ANTHROPIC_BASE_URL="$BASE_URL" ANTHROPIC_API_KEY="$API_KEY" claude --model "$MODEL" "$@"
