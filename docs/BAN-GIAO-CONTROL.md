# Prompt bàn giao — tích hợp Control với agyproxy

> Đưa nguyên file này cho agent đang code phần Control. Nó tự chứa, không cần đọc repo agyproxy.

---

Bạn đang xây dựng **Control** — hệ thống điều khiển bên ngoài cần lấy dữ liệu và ra lệnh
cho **agyproxy**. Đây là tài liệu tích hợp.

## agyproxy là gì

Một gateway gom nhiều tài khoản AI (Antigravity/Gemini + Kiro/Claude) thành một pool, phục
vụ qua API tương thích OpenAI và Anthropic. Nó tự xoay account, quản hạn mức, tự cho account
nghỉ khi bị giới hạn tốc độ. Quy mô thật đang chạy: **~700 account**.

Control cần hai thứ khác nhau, đừng lẫn:

| Việc | Đường đi | Khoá dùng |
|---|---|---|
| **Gọi model** (chat, completion) | `/proxy/v1/*` hoặc `/v1/messages` | **API key gateway** |
| **Quan sát & điều khiển** (xem pool, gỡ cooldown…) | `/api/*` | **CLI token** |

---

## 1. Lấy thông tin kết nối

**Phía agyproxy tạo secret và gửi sang — Control KHÔNG tự sinh key.**

Người vận hành agyproxy lấy chúng ở **Dashboard → Cấu hình → CLI Tools**. Tab đó hiện sẵn
Base URL, CLI token, API key, và danh sách model, mỗi thứ có nút copy.

Bạn sẽ nhận được:

```
Base URL   : http://<host>:7788
CLI token  : <chuỗi 32 ký tự>      → điều khiển agyproxy
API key    : agy-xxxxxxxx…          → gọi model
```

### Hai loại khoá — chỗ dễ nhầm nhất

Dùng sai loại sẽ nhận **401 mà không có thông báo giải thích**. Ghi nhớ:

- **CLI token** → header `Authorization: Basic base64(":" + token)` → gọi `/api/*`
- **API key** → header `Authorization: Bearer <key>` → gọi `/proxy/v1/*`, `/v1/messages`

### Nếu Control cần API key riêng

Báo sang phía agyproxy, họ tạo ở tab **API Keys** rồi gửi. Lưu ý quan trọng:
**key mới chỉ hiện đúng một lần lúc tạo** — máy chủ chỉ lưu mã băm, không lấy lại được.
Nhận được thì lưu ngay vào nơi quản lý bí mật của Control.

---

## 2. Chọn đường tích hợp

### Đường A — MCP (nếu Control là AI agent)

agyproxy có sẵn MCP server. Agent gọi tool thay vì tự dựng HTTP.

Cấu hình (người vận hành lấy bằng `agyproxy setup-mcp`):

```json
{
  "mcpServers": {
    "agyproxy": {
      "command": "node",
      "args": ["/đường/dẫn/agy-proxy/bin/agyproxy-mcp.mjs"],
      "env": { "AGY_URL": "http://<host>:7788", "AGY_TOKEN": "<cli-token>" }
    }
  }
}
```

**14 tool, chia hai nhóm:**

*Đọc — gọi tự do:*

| Tool | Trả về |
|---|---|
| `agyproxy_overview` | Bức tranh tổng: số account, pool bật/cooldown/chết, quota TB, lưu lượng 7 ngày |
| `agyproxy_metrics` | Tức thời: rps, tỉ lệ lỗi, độ trễ p50/p95/p99, request đang bay, circuit breaker |
| `agyproxy_metrics_history` | Chuỗi thời gian các số trên. Tham số `hours` (mặc định 6) |
| `agyproxy_accounts` | Từng account: sức khoẻ, cooldown, % quota, lỗi gần nhất. Tham số `provider` |
| `agyproxy_quota_summary` | Quota TB/thấp nhất toàn pool, phân bố theo tier |
| `agyproxy_models` | Model gọi được, id đã có prefix provider — dùng thẳng khi gọi API |
| `agyproxy_combos` | Combo (chuỗi model dự phòng) đã cấu hình |
| `agyproxy_usage` | Request/token theo thời gian, tách theo model · account · API key |
| `agyproxy_config` | Chiến lược xoay, cooldown, chính sách quota (API key trả dạng che) |
| `agyproxy_runs` | Lịch sử chạy flow login/warmup |

*Ghi — an toàn, đảo ngược được:*

| Tool | Tác dụng |
|---|---|
| `agyproxy_wake` | Gỡ cooldown để account nhận request lại. Bỏ trống `emails` = tất cả |
| `agyproxy_quota_refresh` | Nạp lại hạn mức từ upstream (chạy nền, giãn nhịp) |
| `agyproxy_checklive` | Kiểm tra **một** account còn sống / hết quota / đã chết |
| `agyproxy_set_rotation` | Đổi chiến lược xoay: `round-robin` · `full-first` · `failover` · `highest-first` · `smart` |

### Đường B — HTTP trực tiếp (nếu Control là service/script)

Không cần cài gì. CLI token qua HTTP Basic:

```bash
# Lưu ý dấu ":" trước token — username rỗng, password là token
curl -u ":$CLI_TOKEN" http://<host>:7788/api/overview

curl -u ":$CLI_TOKEN" -X POST http://<host>:7788/api/gateway/accounts/wake \
  -H 'content-type: application/json' -d '{"provider":"agy"}'
```

```javascript
const auth = 'Basic ' + Buffer.from(':' + CLI_TOKEN).toString('base64');
const r = await fetch(`${BASE}/api/overview`, { headers: { authorization: auth } });
const data = await r.json();
```

```python
import requests
r = requests.get(f"{BASE}/api/overview", auth=("", CLI_TOKEN))   # username rỗng
```

---

## 3. Shape dữ liệu thật

Chép từ response thật, không phải mô tả:

**`GET /api/overview`**
```json
{
  "accounts": { "total": 700, "counts": { "agy": { "ok": 348, "failed": 1, "needs_human": 2 } } },
  "proxies": 0,
  "gateway": { "total": 700, "enabled": 700, "cooldown": 17, "dead": 0, "requests": 10, "tokens": 93 },
  "providers": [
    { "id": "agy", "label": "Antigravity", "total": 350, "enabled": 350, "ready": 350,
      "cooldown": 0, "quotaAvg": 87, "requests": 6, "tokens": 51, "estimated": false }
  ]
}
```

**`GET /api/metrics`**
```json
{
  "now": 1786290500749, "uptimeSec": 3, "rssMb": 210,
  "window": { "windowSec": 300, "requests": 0, "errors": 0, "errorRate": 0, "rps": 0,
              "latency": null, "totals": { "requests": 0, "errors": 0 } },
  "accounts": { "agy": { "total": 350, "available": 350, "inflight": 0 },
                "kr":  { "total": 350, "available": 333, "inflight": 0 } },
  "breaker": {}
}
```

Hai chỗ dễ vấp:
- `window.latency` là **`null`** khi cửa sổ không có mẫu nào (gateway rảnh). Đừng đọc
  `latency.p99` mà không kiểm tra null.
- `providers[].quotaAvg` là `null` khi chưa nạp hạn mức lần nào — khác với `0` (đã nạp và
  đã cạn).

**`GET /api/gateway/models`**
```json
{ "models": [
  { "id": "agy/gemini-2.5-pro", "bare": "gemini-2.5-pro", "label": "Gemini 2.5 Pro",
    "provider": "agy", "providerLabel": "Antigravity", "image": false, "maxInput": 1048576 }
]}
```
Dùng `id` (đã có prefix) khi gọi model, không dùng `bare`.

---

## 4. Ranh giới an toàn

Những endpoint sau **có thật** nhưng Control **không nên gọi**, kèm lý do cụ thể:

| Endpoint | Vì sao |
|---|---|
| `POST /api/gateway/accounts/bulk` không kèm `emails` | Mặc định áp cho **TOÀN BỘ** pool — tắt sạch 700 account bằng một lệnh |
| `POST /api/gateway/accounts/check` | Quét cả pool ~1.2 giây/account (700 account ≈ 14 phút) và chạy dày sẽ **bị upstream chặn tốc độ, tự giết pool** |
| `PATCH /api/gateway/config {"enabled":false}` | Tắt gateway — mọi request suy luận dừng ngay |
| `PATCH /api/gateway/config {"regenerateKey":true}` | Sinh API key mới → **mọi client đang dùng chết ngay** |
| `POST /api/system/restart` · `/api/system/update` | Dừng/cập nhật server |
| `POST /api/security/password` | Đổi mật khẩu dashboard — có thể tự khoá người vận hành ra ngoài |
| `DELETE /api/accounts/*` · `/api/gateway/keys/*` | Xoá vĩnh viễn, không hoàn tác |
| `GET /api/backup/export` · `/api/credentials` · `?reveal=1` | Trả về token và credential nguyên văn |

**MCP server đã chặn sẵn toàn bộ nhóm này** — nếu đi đường A thì không gọi tới được. Đi
đường B (HTTP trực tiếp) thì Control phải tự giữ ranh giới.

---

## 5. Tự khám phá thêm

- `agyproxy routes --json` — liệt kê toàn bộ 91 endpoint dạng `{method, path}`
- **Dashboard → Cấu hình → CLI Tools → Thử API** — gọi thử endpoint bất kỳ ngay trong trình
  duyệt để xem shape dữ liệu **trước khi** viết code. Nhanh hơn đoán rồi sửa.

## 6. Khi gặp lỗi

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| `401 {"error":"unauthorized"}` | Dùng nhầm loại khoá (xem mục 1), hoặc thiếu dấu `:` trước token trong Basic auth |
| `503 {"error":{"message":"gateway disabled"}}` | Gateway đang tắt — người vận hành bật lại ở Dashboard |
| Kết nối bị từ chối | Sai cổng, hoặc server chỉ nghe `127.0.0.1` mà Control gọi từ máy khác |

`GET /api/health` **không cần xác thực** — dùng để kiểm tra server sống trước khi báo lỗi auth.
