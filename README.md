# agy-proxy

Cổng **OpenAI/Anthropic-compatible** gom pool nhiều tài khoản **Antigravity** (Google Gemini Code Assist) + **Kiro** (AWS CodeWhisperer) + dashboard quản lý. Phục vụ model qua `/proxy/v1` (OpenAI) và `/v1/messages` (Anthropic) với xoay tài khoản thông minh, hạn mức, combo fallback, báo cáo, backup.

## Tính năng

- **Gateway đa giao thức**: `/proxy/v1/chat/completions` (OpenAI), `/v1/messages` (Anthropic)
- **35+ models** từ 2 provider: Gemini (Antigravity) + Claude (Kiro)
- **Xoay tài khoản concurrency-aware**: LRU round-robin, cooldown khi 429, monthly quota sleep
- **Combo routing**: fallback chain theo task (code/research/fast/agent/vision)
- **Tool-use cho mọi provider** (kể cả Kiro bypass qua prompt injection)
- **Chống 429**: concurrency limiter, exponential backoff, account blacklist
- **Dashboard React** (shadcn/ui + Tailwind + Lucide) — dark theme, responsive
- **Live call log**, báo cáo, backup/restore

## Cài đặt

Cần **Node ≥ 24** (cho `node:sqlite`).

```bash
git clone https://github.com/mvng267/agy-proxy
cd agy-proxy
npm install
agyproxy start -d              # chạy nền
agyproxy service install       # tự chạy khi reboot (launchd macOS / systemd Linux)
```

Mở dashboard: `http://localhost:7788` (mật khẩu mặc định `123456`)

---

## Sử dụng với Claude Code / Coding Agents

agy-proxy hoạt động như proxy — client (Claude Code, Hermes, opencode...) trỏ `base_url` vào `http://localhost:7788`.

### Cách 1: `agyproxy claude` (khuyên dùng)

Mở Claude Code qua agy-proxy với model/combo theo task type:

```bash
agyproxy claude code "refactor file auth.ts"      # combo/code: Opus 4.6 → Sonnet 4.5
agyproxy claude fast -p "explain this code"       # combo/fast: Haiku → Gemini flash
agyproxy claude research "phân tích performance"  # combo/research: Opus → Gemini pro
agyproxy claude agent "viết unit test"            # combo/agent: Sonnet → Opus
agyproxy claude vision "đọc ảnh này"              # combo/vision: Gemini pro → Sonnet
agyproxy claude kr/claude-sonnet-4.5 "hello"      # model cụ thể
agyproxy claude combo/my-combo "task"             # combo tự định nghĩa
```

### Cách 2: Alias (thêm vào ~/.zshrc)

```bash
alias claude-agy='ANTHROPIC_API_KEY="$(grep "^HERMES_CUSTOM_LOCALHOST_7788_API_KEY=" ~/.hermes/.env | cut -d= -f2-)" ANTHROPIC_BASE_URL="http://localhost:7788" claude'
alias claude-max='unset ANTHROPIC_BASE_URL && claude'   # Claude Max gốc
```

Dùng: `claude-agy -p "hi"` hoặc `claude-agy --model combo/code "refactor X"`

### Cách 3: Env vars (script/CI)

```bash
export ANTHROPIC_BASE_URL=http://localhost:7788
export ANTHROPIC_API_KEY="$(grep "^HERMES_CUSTOM_LOCALHOST_7788_API_KEY=" ~/.hermes/.env | cut -d= -f2-)"
claude --model combo/code "task..."
```

### Cách 4: Hermes native

Trong `~/.hermes/config.yaml`:
```yaml
model:
  provider: custom:agyproxy
  base_url: http://localhost:7788/proxy/v1
  api_key: ${HERMES_CUSTOM_LOCALHOST_7788_API_KEY}
  api_mode: anthropic_messages
```

---

## Chia task theo model (khuyên)

| Task type | Combo | Model chạy | Dùng khi |
|-----------|-------|-----------|---------|
| `code` | `combo/code` | Opus 4.6 → Sonnet 4.5 | Refactor, architect, bug phức tạp, feature mới |
| `fast` | `combo/fast` | Haiku 4.5 → Gemini flash | Hỏi nhanh, explain, format, lint |
| `research` | `combo/research` | Opus 4.6 → Gemini pro | Phân tích dài, đọc hiểu codebase lớn |
| `agent` | `combo/agent` | Sonnet 4.5 → Opus 4.6 | Task tổng quát, chat đa năng |
| `vision` | `combo/vision` | Gemini pro → Sonnet 4.5 | Đọc ảnh, screenshot, UI analysis |

**Nguyên tắc:** Code nặng → `code` (Opus nghĩ sâu) · Code nhẹ → `fast` (Haiku rẻ nhanh) · Đọc hiểu nhiều → `research` (Opus + context dài)

---

## Quản lý Combo (Dashboard)

1. Mở `http://localhost:7788` → tab **Combo**
2. Thêm combo: `id=my-combo`, targets=`[{"model":"agy/claude-opus-4-6-thinking","weight":2},{"model":"kr/claude-sonnet-4.5","weight":1}]`
3. Gọi: `agyproxy claude combo/my-combo "task"`

Hoặc script: `node scripts/setup-combos.mjs` (tạo 5 combos mặc định)

---

## Lệnh CLI

| Lệnh | Việc |
|------|------|
| `agyproxy start` | chạy foreground |
| `agyproxy start -d` | chạy nền (daemon) |
| `agyproxy stop` | dừng |
| `agyproxy restart` | khởi động lại |
| `agyproxy status` | trạng thái + account + pool |
| `agyproxy logs -f` | xem log realtime |
| `agyproxy claude <type>` | mở Claude Code qua agy-proxy (model theo task) |
| `agyproxy model --big <m> --small <m>` | đổi model mặc định |
| `agyproxy service install` | tự chạy khi reboot |
| `agyproxy update` | tự cập nhật từ GitHub |
| `agyproxy accounts on/off` | bật/tắt account |
| `agyproxy accounts wake` | gỡ cooldown tất cả |
| `agyproxy backup` | backup thủ công |
| `agyproxy version` | phiên bản |

### CLI tools (setup)

```bash
agyproxy setup-claude     # cấu hình Claude Code trỏ vào agy-proxy
agyproxy setup-hermes     # cấu hình Hermes native
agyproxy setup-codex      # cấu hình Codex
```

---

## Điều khiển agyproxy từ tool ngoài

Toàn bộ agyproxy điều khiển được qua CLI hoặc HTTP, kể cả từ máy khác.

### Kết nối — 2 bước

```bash
# 1. TRÊN MÁY CHỦ: lấy token
agyproxy token

# 2. TRÊN MÁY TOOL: lưu lại (kiểm tra ngay, sai token là báo liền)
agyproxy connect http://100.112.240.4:7788 --token <token>

agyproxy ping        # ✓ http://100.112.240.4:7788  23ms  v2.18.1  700 account
```

Lưu ở `~/.agyproxy/cli.json` (chmod 600). Từ đây mọi lệnh đều chạy trên server đó.

Không muốn lưu file thì dùng biến môi trường — hợp với CI/container:

```bash
export AGY_URL=http://100.112.240.4:7788
export AGY_TOKEN=<token>
```

Thứ tự ưu tiên: `--url/--token` › `AGY_URL/AGY_TOKEN` › `cli.json` › local.

### Gọi bất kỳ endpoint nào

`agyproxy api` là đường đi tới **toàn bộ ~88 endpoint**, kể cả endpoint thêm sau này —
không phải chờ CLI bọc thêm lệnh con:

```bash
agyproxy routes                      # liệt kê endpoint (--json để máy đọc)

agyproxy api /api/overview           # GET là mặc định
agyproxy api /api/gateway/accounts?provider=agy

agyproxy api PATCH /api/gateway/config '{"rotation":"smart"}'
agyproxy api POST  /api/gateway/accounts/wake '{"provider":"agy"}'
agyproxy api POST  /api/system/update        # cập nhật server từ xa
agyproxy api POST  /api/system/restart       # khởi động lại từ xa

cat accounts.json | agyproxy api POST /api/accounts/import -   # `-` = đọc stdin
```

Kết quả luôn là JSON thô trên stdout (lỗi ra stderr + exit≠0), nên ghép `jq` và
`set -e` được:

```bash
agyproxy api /api/overview | jq '.gateway.enabled'
agyproxy status --json | jq -e '.up'      # exit≠0 nếu server chết → dùng cho healthcheck
```

### Không cài CLI cũng được

Token đi qua HTTP Basic, nên bất cứ thứ gì gọi được HTTP đều điều khiển được:

```bash
curl -u ":$AGY_TOKEN" http://100.112.240.4:7788/api/overview

curl -u ":$AGY_TOKEN" -X PATCH http://100.112.240.4:7788/api/gateway/config \
  -H 'content-type: application/json' -d '{"rotation":"smart"}'
```

```python
import requests
r = requests.get("http://100.112.240.4:7788/api/overview", auth=("", TOKEN))
```

### Lệnh chỉ chạy được tại máy chủ

`start` · `stop` · `logs` · `update` · `service` thao tác tiến trình cục bộ. Khi đang trỏ
sang máy khác, CLI **chặn và chỉ đường** thay vì lặng lẽ tác động nhầm server trên máy
đang gõ. Từ xa dùng `agyproxy api POST /api/system/restart` (hoặc `/api/system/update`).

> ⚠ Token cho **toàn quyền** điều khiển gateway. Chỉ truyền qua mạng tin cậy
> (Tailscale/VPN) hoặc HTTPS. Đổi token: xoá khoá `cliToken` trong bảng `settings`
> rồi chạy lại `agyproxy token`.

---

## Cấu trúc dự án

```
agy-proxy/
├── src/                 # Backend (Fastify + TypeScript)
│   ├── gateway/         # Pool, routes, providers (agy/kiro), combo
│   ├── store/           # DB (sqlite), CSV
│   └── index.ts         # Entry point
├── web/                 # Frontend React (Vite + shadcn/ui)
│   ├── src/components/  # AppSidebar, Overview, ui/*
│   └── dist/            # Build output (agy-proxy serve cái này)
├── bin/agyproxy.mjs     # CLI
├── scripts/             # setup-combos.mjs, claude-task.sh
└── public/              # (đã xóa — thay bằng web/dist)
```

## Phát triển

```bash
# Backend
npm run dev              # tsx watch src/index.ts

# Frontend (React)
cd web
npm run dev              # Vite dev server (port 5173, proxy /api → :7788)
npm run build            # build → web/dist

# Sau khi build React, copy login.html:
cp ../public/login.html dist/login.html   # (chỉ lần đầu, login.html đã có trong dist)
```

## Phân vai máy

| Máy | Vai trò | Gateway | Cập nhật code |
|-----|---------|---------|---------------|
| macOS (local) | **Test** — chạy test, thử tính năng | `agyproxy off` | `git pull` như thường |
| Debian `100.112.240.4` | **Production** — phục vụ client thật | BẬT | nút "Cập nhật" trên dashboard, hoặc `agyproxy update` |

Máy test để `off` để hai máy không cùng đốt quota của một pool credential — không có
cơ chế điều phối giữa hai instance, cùng gọi thì dễ 429 chéo. Bật lại khi cần test
đường gọi thật: `agyproxy on`.

> **Chạy `npm test` thì phải BẬT gateway.** Vài test tích hợp gọi qua `/proxy/v1/*`
> nên sẽ đỏ khi gateway `off` (vd "POST /proxy/v1/responses tồn tại"). Trình tự:
> `agyproxy on && npm test && agyproxy off`.

Production nhận code qua GitHub (`origin/main`), KHÔNG qua patch thủ công — patch tạo
commit hash khác nên `git pull` sẽ xung đột và nút "Cập nhật" ngừng hoạt động.

## Deployment

Hai script trong `scripts/`, cấu hình hoàn toàn qua biến env (không hardcode host/path):

| Biến | Dùng cho | Ý nghĩa |
|------|----------|---------|
| `DEPLOY_HOST` | cả hai | SSH target, vd `deploy@1.2.3.4` hoặc alias trong `~/.ssh/config` |
| `DEPLOY_WEB_PATH` | web | Thư mục `web/dist` trên server, vd `/opt/agy-proxy/web/dist` |
| `DEPLOY_PATH` | backend | Thư mục app trên server, vd `/opt/agy-proxy` |
| `DEPLOY_PORT` | cả hai | Cổng SSH (mặc định 22) |

Tiện nhất: tạo file `.env.deploy` (đã gitignore) chứa các `export ...` rồi `source .env.deploy`.

### Deploy web dashboard

```bash
source .env.deploy
npm run deploy:web            # build web/ → rsync dist/ lên $DEPLOY_WEB_PATH
npm run deploy:web -- --dry-run   # chỉ build + in lệnh rsync, không đẩy
SKIP_BUILD=1 npm run deploy:web   # sync dist/ sẵn có, bỏ qua build
```

Backend serve dashboard tĩnh từ `web/dist` (`src/paths.ts`), nên deploy web **không cần restart** backend.

### Deploy backend

Backend chạy trực tiếp bằng `tsx` (không có bước build). Script sync source lên server
(exclude `data/`, `profiles/`, `.env` — state trên server được giữ nguyên), chạy
`npm ci --omit=dev`, rồi restart:

```bash
source .env.deploy
npm run deploy:backend            # rsync source → npm ci → restart
npm run deploy:backend -- --dry-run
```

Thứ tự ưu tiên restart trên server:

1. **pm2** (nếu có): `pm2 restart agy-proxy`, lần đầu tự `pm2 start npm --name agy-proxy -- start`
2. **systemd** (nếu có unit `agy-proxy.service`): `sudo systemctl restart agy-proxy`
3. Không có gì → in hướng dẫn chạy tay

Systemd unit mẫu (`/etc/systemd/system/agy-proxy.service`):

```ini
[Unit]
Description=agy-proxy gateway
After=network.target

[Service]
WorkingDirectory=/opt/agy-proxy
ExecStart=/usr/bin/node --import tsx src/index.ts
Restart=on-failure
EnvironmentFile=/opt/agy-proxy/.env

[Install]
WantedBy=multi-user.target
```

### Docker (thay thế)

Đã có sẵn `Dockerfile` + `docker-compose.yml` (image kèm Chromium cho login flow):

```bash
docker compose up -d --build
```

## Bảo mật

- Dashboard: Basic auth (mật khẩu `123456` đổi trong `.env` `DASHBOARD_PASSWORD`)
- Gateway: `GATEWAY_API_KEY` (tự sinh khi `agyproxy start`)
- Credentials: KHÔNG commit lên git (accounts.csv, credentials.csv trong `.gitignore`)
