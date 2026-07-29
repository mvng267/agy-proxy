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
