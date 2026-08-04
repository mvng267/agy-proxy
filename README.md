# agy-proxy

Cổng **OpenAI-compatible** gom pool nhiều tài khoản **Antigravity** (Google Gemini Code Assist) + dashboard quản lý. Harvest tài khoản bán tự động qua Playwright, phục vụ model qua `/proxy/v1` với xoay tài khoản, hạn mức, báo cáo, backup.

## Tính năng
- **Gateway OpenAI-compatible** (`/proxy/v1/chat/completions`, `/proxy/v1/models`) — dán Base URL vào tool coding (opencode/cline…). Gọi được: gemini-3-pro-high/low, gemini-3-flash, gemini-2.5-flash/pro, claude-sonnet-4-6, claude-opus-4-6-thinking, model ảnh…
- **Xoay tài khoản** concurrency-aware: round-robin / full-first / failover / cao-nhất-trước. Nhiều request song song tự trải ra tài khoản rảnh; dedupe refresh token; cooldown khi 429.
- **Hạn mức đầy đủ** như Antigravity trả về (nhóm Gemini/Claude + per-model + reset countdown), 2 chế độ Bảng/Thẻ, tự nạp nền.
- **Báo cáo sử dụng** theo ngày/tuần/model/account + export CSV; **trang Tổng quan** có biểu đồ.
- **Live call log** request→response realtime; **check live / check token** từng account hoặc tất cả (hiển thị realtime).
- **Backup/restore toàn bộ** bằng 1 file JSON (accounts + proxies + credentials + gateway + config).
- Dashboard 100% ReUI, dark/light, responsive.

## Cài đặt CLI (khuyến nghị — giống 9router)
Cần **Node ≥ 24** (cho `node:sqlite`). Harvest login thì cần thêm Google Chrome.
```bash
npm install -g github:mvng267/agy-proxy
npx playwright install chrome      # chỉ cần nếu dùng harvest login

agyproxy start -d                  # chạy nền
agyproxy status                    # trạng thái + số liệu
```

### Lệnh CLI
| Lệnh | Việc |
|---|---|
| `agyproxy start` | chạy foreground |
| `agyproxy start -d` | **chạy nền** (daemon, ghi PID + log) |
| `agyproxy stop` | dừng tiến trình nền |
| `agyproxy restart` | khởi động lại (nền) |
| `agyproxy status` | trạng thái + account + pool + usage |
| `agyproxy logs -f` | xem log realtime |
| `agyproxy update` | **kiểm tra GitHub & tự cập nhật** (git pull hoặc npm -g) |
| `agyproxy update --check` | chỉ kiểm tra có bản mới |
| `agyproxy service install` | **tự chạy khi reboot** (systemd trên Linux/VPS · launchd trên macOS) |
| `agyproxy service uninstall` | gỡ tự chạy |
| `agyproxy service start\|stop\|restart\|status` | bật/tắt/xem service |
| `agyproxy version` | phiên bản |

### Cho máy khác truy cập qua IP
Mặc định server chỉ bind `127.0.0.1` (chỉ máy cài). Mở ra LAN/Internet:
```bash
agyproxy restart --host 0.0.0.0          # hoặc đặt HOST=0.0.0.0 trong .env
# → máy khác vào: http://<IP-máy>:7788
```
> ⚠️ **Bắt buộc đặt mật khẩu khi mở**: dashboard hiển thị refresh_token và cho export backup kèm token.
> Trong `.env`: `DASHBOARD_PASSWORD=matkhau_cua_ban` → trình duyệt sẽ hỏi (user bỏ trống, chỉ nhập password).
> Endpoint `/proxy/v1/*` không dùng mật khẩu này mà dùng `GATEWAY_API_KEY` riêng (đặt trong tab Pool).

### Tự chạy khi reboot (VPS / aaPanel)
```bash
agyproxy service install     # systemd --user + enable-linger → lên lại sau reboot
agyproxy service status
```
Service có **auto-restart** (Restart=always / KeepAlive): process chết là tự dựng lại. Gỡ bằng `agyproxy service uninstall`.
Trên macOS, nếu source nằm trong `~/Desktop`/`~/Documents` thì log service ghi ở `~/Library/Logs/agyproxy.log` (do macOS TCC chặn LaunchAgent ghi vào các thư mục đó).

Dữ liệu mặc định ở `~/.agyproxy` (accounts, token, profiles, log). Đổi bằng env `AGY_HOME`. Nếu chạy từ thư mục source đã có `data/` thì giữ nguyên chỗ cũ.

## Chạy từ source (dev)
```bash
npm install
npx playwright install chrome
cp .env.example .env          # chỉnh nếu cần
npm start                     # http://localhost:7788
```

## Chạy Docker (full, kèm Chrome — harvest + gateway)
```bash
docker compose up -d --build
# Dashboard: http://localhost:7788   ·   Gateway: http://localhost:7788/proxy/v1
```
- Volume `agy-data` (accounts/tokens/gateway), `agy-profiles` (session Chrome mỗi account), `agy-screenshots` — **persist** qua restart.
- `OMNIROUTE_URL` mặc định `host.docker.internal:20128` (OmniRoute chạy trên host). App **không crash** nếu OmniRoute offline.
- **Lưu ý:** login/harvest từ IP datacenter dễ dính checkpoint Google → gán **proxy sạch** cho account khi harvest. Gateway `/proxy/v1` không cần browser, chạy tốt mọi nơi.

## Harvest (bán tự động)
1. **Proxy**: dán link Webshare hoặc list `ip:port:user:pass` → Import → Gán tự động (sticky 1 account 1 proxy).
2. **Tài khoản**: Sinh dải / Import list / thêm đơn lẻ.
3. **Chạy**: nút **Full** mỗi dòng, hoặc **Auto Run** (hàng đợi tuần tự, giãn nhịp). 1 account = 1 profile Chrome vĩnh viễn.
4. **Challenge**: gặp 2FA/CAPTCHA → panel "Cần xử lý tay", thao tác trên Chrome rồi bấm Tiếp tục.

## Backup
- Export: **Cấu hình → Sao lưu & phục hồi → Export** (tải `antigravity-backup_<ngày>.json`).
- Restore: chọn file → Gộp/Thay thế. File **chứa token — giữ an toàn, không commit**.

## Biến môi trường chính
`PORT` `HOST` `HEADLESS` `CHROME_NO_SANDBOX` `OMNIROUTE_URL` `OMNIROUTE_PASSWORD` `GATEWAY_ROTATION` `GATEWAY_API_KEY` `GATEWAY_QUOTA_*` `PACING_MIN_SEC` `PACING_MAX_SEC` `DAILY_LOGIN_CAP` `FINGERPRINT` `CHROME_MAJOR` `TOKEN_HEALTH_HOURS` — xem `.env.example`.

> ⚠️ `data/`, `profiles/`, `.env` đã nằm trong `.gitignore` — không đẩy token/credential lên git. Gộp nhiều account free-tier có thể trái ToS Google; tự cân nhắc.

## Gateway 2 provider: `agy/` + `kr/`
Model **bắt buộc có prefix** (gọi id trần → 400 kèm gợi ý đúng):

| Prefix | Nguồn | Model |
|---|---|---|
| `agy/` | Antigravity (188 account) | **20 model** — gemini-3-pro-high/low, gemini-3.1-pro-preview/low, gemini-3-flash, gemini-3.6-flash-high/medium/low, gemini-3.5-flash-high/low/extra-low, gemini-3.1-flash-lite, gemini-2.5-flash/pro/flash-thinking/flash-lite, gemini-3.1-flash-image, claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium |
| `kr/` | Kiro / AWS CodeWhisperer (147 account) | claude-sonnet-4, claude-3-7-sonnet, claude-haiku-4-5 |
| `combo/<tên>` | Chuỗi model tự fallback | tạo ở trang **Combo** |
| `auto`, `auto/fast\|quota\|stable` | Tự chấm điểm chọn đường mỗi request | không cần tạo |

Kiro **không có API hạn mức**; hết hạn mức tháng trả `402 MONTHLY_REQUEST_COUNT` → account tự nghỉ 12h và request chuyển sang account khác.

## Endpoint
| Chuẩn | URL | Dùng cho |
|---|---|---|
| OpenAI | `http://host:7788/proxy/v1` | Codex, Hermes, Cline, Aider, opencode… |
| **Anthropic** | `http://host:7788` (**không** kèm `/v1`) | **Claude Code** (tự gọi `/v1/messages`) |

> **Tool-use (Claude Code sửa file / chạy lệnh): CHẠY ĐƯỢC** với model `agy/` — dịch đủ
> `tools` → Gemini `functionDeclarations`, `tool_use`/`tool_result` cả stream lẫn non-stream,
> **nhiều vòng** (gọi tool → nhận kết quả → gọi tiếp). Đã kiểm chứng thật trên
> `agy/gemini-3-flash`, `agy/gemini-3-pro-low`, `agy/gemini-2.5-flash`,
> `agy/claude-sonnet-4-6`, `agy/claude-opus-4-6-thinking`.
> Model `kr/` (Kiro/CodeWhisperer) **không có function calling native** → gửi kèm tool sẽ bị
> từ chối bằng `400` kèm hướng dẫn, thay vì im lặng trả text (làm Claude Code treo).
> Combo/auto tự bỏ qua bước `kr/` khi request có tool.

## Cắm tool coding (1 chạm)
Trang **CLI Tools** trong dashboard, hoặc terminal:
```bash
agyproxy setup-claude --profile --model kr/claude-sonnet-4   # profile riêng, KHÔNG đụng settings.json gốc
agyproxy setup-claude --model kr/claude-sonnet-4             # merge vào settings.json (có backup)
agyproxy setup-codex  --model agy/gemini-3-pro-low
agyproxy setup-hermes --model combo/main
agyproxy setup-antigravity
# --dry-run xem trước · --undo gỡ và khôi phục backup
```
Mọi thao tác ghi file đều: chỉ trong `$HOME`, **merge** (không đè), **backup** `.agybak-*` (giữ 5 bản), ghi atomic, `chmod 600`. **Không bao giờ** sửa `~/.zshrc`.

> ⚠️ Nếu gateway bind `0.0.0.0` mà **chưa đặt API key**, việc cấu hình tool bị **từ chối** — vì lúc đó gateway là open relay tới toàn bộ account.
