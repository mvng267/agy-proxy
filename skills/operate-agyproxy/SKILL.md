---
name: operate-agyproxy
description: Quan sát và điều khiển pool agyproxy đang chạy — chẩn đoán khi gateway lỗi/chậm, gỡ cooldown, nạp lại hạn mức, đổi chiến lược xoay. Dùng MCP hoặc CLI.
---

# Vận hành agyproxy

Kỹ năng này dành cho lúc **hệ thống đang chạy có vấn đề** — không phải lúc sửa code.

agyproxy gom ~700 tài khoản AI thành một pool và phục vụ qua API tương thích OpenAI/Anthropic.
Khi client báo chậm, lỗi, hay hết hạn mức, dùng skill này để tìm nguyên nhân và khắc phục.

## Trước tiên: bạn có kết nối chưa

Kiểm tra theo thứ tự, dừng ở bước đầu tiên thành công:

```bash
agyproxy ping          # ✓ http://... 23ms v2.18.1 700 account
```

- **Chạy được** → đi tiếp.
- **Báo "Chưa có token"** → chưa kết nối. Lấy thông tin ở Dashboard → Cấu hình → CLI Tools,
  rồi `agyproxy connect <url> --token <token>`.
- **Không có lệnh `agyproxy`** → dùng HTTP trực tiếp: `curl -u ":$TOKEN" <url>/api/overview`
  (lưu ý dấu `:` trước token — username rỗng).

Nếu môi trường có MCP server `agyproxy` thì dùng tool thay cho CLI: tên tool trùng với
endpoint (`agyproxy_overview`, `agyproxy_metrics`…).

## Quy trình chẩn đoán

**Luôn đọc trước khi ghi.** Ba lệnh đầu cho biết 90% tình huống:

```bash
agyproxy api /api/overview     # pool còn bao nhiêu account sống, quota trung bình
agyproxy api /api/metrics      # rps, tỉ lệ lỗi, độ trễ p99, circuit breaker
agyproxy status                # gọn hơn, đủ cho câu hỏi "có ổn không"
```

Đọc theo thứ tự này để không kết luận sai:

| Triệu chứng | Nhìn vào | Nếu đúng thì |
|---|---|---|
| Client bị 429 / "hết account" | `gateway.cooldown` cao | Pool đang nghỉ hàng loạt → xem mục "Gỡ cooldown" |
| Client bị 503 | `/api/gateway/config` → `enabled` | Gateway bị tắt → người vận hành bật lại |
| Chậm bất thường | `metrics.window.latency.p99` | So với `p50`; lệch lớn = một số account chậm |
| Lỗi rải rác | `metrics.breaker` | Breaker `open` = provider đó đang hỏng |
| "Hết hạn mức" | `/api/gateway/quota-summary` | `geminiAvg` thấp = pool cạn thật, không phải lỗi |

**Cạm bẫy khi đọc số:**

- `window.latency` là **`null`** khi cửa sổ 5 phút không có request nào — nghĩa là gateway
  đang rảnh, **không** phải độ trễ bằng 0.
- `quotaAvg` là `null` khi chưa nạp hạn mức lần nào — khác hẳn `0` (đã nạp và đã cạn).
- `accounts.available` đếm account **dùng được ngay**; `total` gồm cả account đang cooldown.
  Chênh lệch lớn giữa hai số là dấu hiệu pool đang nghỉ chứ không phải chết.

## Khắc phục

Bốn hành động an toàn, đảo ngược được:

```bash
# Gỡ cooldown — dùng sau khi sự cố upstream đã qua.
# KHÔNG đụng tới bật/tắt hay sức khoẻ account.
agyproxy api POST /api/gateway/accounts/wake '{"provider":"agy"}'

# Nạp lại hạn mức (chạy nền, giãn nhịp để không cạnh tranh với request thật)
agyproxy api POST /api/gateway/quota/refresh '{}'

# Kiểm tra MỘT account
agyproxy api POST '/api/gateway/accounts/<email>/checklive'

# Đổi chiến lược xoay
agyproxy api PATCH /api/gateway/config '{"rotation":"smart"}'
```

Năm chiến lược xoay: `round-robin` (lần lượt) · `full-first` (dùng cạn account đầu) ·
`failover` (chỉ chuyển khi lỗi) · `highest-first` (ưu tiên account nhiều quota) ·
`smart` (cân theo quota và độ trễ).

## KHÔNG được làm

Những thứ này gọi được về mặt kỹ thuật nhưng gây hậu quả thật. **Hỏi người vận hành trước.**

| Việc | Hậu quả |
|---|---|
| `POST /api/gateway/accounts/bulk` không kèm `emails` | Áp cho **TOÀN BỘ** pool — tắt sạch 700 account bằng một lệnh |
| `POST /api/gateway/accounts/check` | Quét cả pool ~1.2 giây/account (700 account ≈ 14 phút) và chạy dày sẽ **bị upstream chặn tốc độ, tự giết pool** |
| `PATCH /api/gateway/config {"enabled":false}` | Tắt gateway — mọi request suy luận dừng ngay |
| `{"regenerateKey":true}` | Sinh API key mới → **mọi client đang dùng chết ngay** |
| `POST /api/system/restart` · `/api/system/update` | Dừng/cập nhật server |
| `POST /api/security/password` | Đổi mật khẩu dashboard — có thể khoá chính người vận hành ra ngoài |
| `DELETE /api/accounts/*` | Xoá vĩnh viễn, không hoàn tác |
| `GET /api/backup/export` · `/api/credentials` · `?reveal=1` | Trả token và credential **nguyên văn** — đừng in ra log hay chat |

**Nếu bạn dùng MCP thì cả nhóm này đã bị chặn sẵn** — allowlist chỉ có 12 tool đọc + 4 tool
ghi an toàn. Dùng CLI/HTTP trực tiếp thì phải tự giữ ranh giới.

## Truy vết: từ "có lỗi" đến "lỗi ở đâu"

`/api/metrics` cho biết **có** lỗi, không cho biết **ở đâu**. Log chi tiết trả lời tiếp:

```bash
# 429 tập trung ở model nào? — đọc facets.models trong kết quả
agyproxy api '/api/gateway/usage/logs?range=30d&status=429&limit=20'

# một account cụ thể hỏng thế nào
agyproxy api '/api/gateway/usage/logs?range=7d&email=abc@x.vn&ok=false'

# đường vào nào đang lỗi nhiều — /v1/messages hay /v1/chat/completions
agyproxy api '/api/gateway/usage/logs?range=7d&ok=false'
```

Lọc theo `email · model · endpoint · status · ok · stream`, chồng nhau thì AND.
`facets` liệt kê giá trị **có thật** kèm số lần — dùng nó để biết lọc theo gì, đừng đoán.

MCP có sẵn hai tool tương ứng: `agyproxy_usage_logs`, `agyproxy_usage_compare`.

## Thử một model ngay

```bash
agyproxy chat agy/gemini-3-flash "2+2 bằng mấy?"
agyproxy chat agy/gemini-3.1-flash-image "vẽ con mèo" --out meo.png
```

Đi qua cùng đường với `/proxy/v1` nên **có failover** — nếu lệnh này lỗi thì client thật
cũng lỗi. Ngược lại, nó chạy mà client báo hỏng thì vấn đề nằm ở phía client.

## Tự khám phá thêm

```bash
agyproxy routes --json     # 105 endpoint dạng {method, path}
agyproxy api /api/gateway/models    # model gọi được, id đã có prefix provider
```

Dashboard → Cấu hình → **CLI Tools → Thử API**: gọi thử endpoint ngay trong trình duyệt để
xem shape dữ liệu trước khi viết code.

## Hai loại khoá — chỗ dễ nhầm nhất

Dùng sai loại nhận **401 không kèm giải thích**:

- **CLI token** → `Authorization: Basic base64(":" + token)` → gọi `/api/*` (điều khiển)
- **API key gateway** → `Authorization: Bearer <key>` → gọi `/proxy/v1/*` (gọi model)

`GET /api/health` **không cần xác thực** — dùng để phân biệt "server chết" với "sai khoá".

## Báo cáo kết quả

Khi xong, nói rõ ba điều:

1. **Đã đo được gì** — trích số thật, không nói "có vẻ ổn"
2. **Đã thay đổi gì** — lệnh nào, tác động tới bao nhiêu account
3. **Còn gì chưa xử lý** — và vì sao (cần quyết định của người vận hành, hay nằm ngoài phạm vi)

Tài liệu tích hợp đầy đủ cho hệ thống ngoài: `docs/BAN-GIAO-CONTROL.md`.
