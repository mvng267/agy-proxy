# Vá OmniRoute: dedupe Kiro theo refreshToken

## Lỗi

OmniRoute chỉ giữ được **một** connection Kiro. Đổ 20 credential (20 refreshToken khác
nhau) thì API trả `{"success":true}` cả 20 lần, nhưng bảng `provider_connections` chỉ có
**1 hàng**, cùng một `id`.

Nguyên nhân: `findKiroConnectionByIdentity` khớp `profileArn` trước, mà Kiro free-tier cấp
**chung một ARN** cho mọi tài khoản Google:

```
arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK
```

Đo trên 20 tài khoản `@luongthevinhhp.edu.vn`: **20/20 giống hệt nhau**. Gửi thêm
`email`/`name` không cứu được vì `kiroImportSchema` strip chúng, và bỏ `profileArn` khỏi
payload cũng vô ích — OmniRoute tự đọc ARN từ token lúc refresh.

## Bản vá

Thêm `refreshToken` làm khoá nhận dạng, đặt **trước** `profileArn`. Token khác mà không
hàng nào khớp thì trả `null` (tài khoản mới) thay vì rơi xuống ARN dùng chung.

Chỉ thêm nhánh mới, không sửa logic cũ: payload không kèm `refreshToken` vẫn chạy y như
trước.

## Áp

```bash
cd "$(npm root -g)/omniroute"
git apply /đường/dẫn/kiro-dedupe-refreshtoken.patch   # hoặc: patch -p1 < ...
```

## ⚠ KHÔNG build lại được — phải vá thẳng vào dist

Đã thử `npm run build`: **chết ngay**. Gói npm không ship `app/` (toàn bộ trang Next.js),
`next.config`, lẫn `scripts/build/assembleStandalone.mjs` — nó cố tình chỉ phát hành bản đã
build. Vá `src/` vì thế vô tác dụng: runtime đọc `dist/.build`.

**Dùng `va-dist.mjs`** — vá thẳng vào JS đã build (tên hàm còn nguyên, không bị minify):

```bash
node va-dist.mjs                 # vá (tự sao lưu vào dist-backup/)
node va-dist.mjs --go            # khôi phục bản gốc
# rồi khởi động lại OmniRoute
```

Nó vá **hai** chỗ, thiếu một là vô nghĩa:
1. thân hàm `findKiroConnectionByIdentity` — thêm nhánh `refreshToken` trước `profileArn`
2. hai nơi gọi — truyền `refreshToken` vào identity (trước chỉ có profileArn/clientId/email)

Mất khi `npm update -g omniroute` → chạy lại `va-dist.mjs`.

### Đã kiểm chứng thật (23/08/2026)

| | Trước vá | Sau vá |
|---|---|---|
| Đổ 20 credential | **1** connection | **20** connection |
| refresh_token khác nhau | — | **20/20** |
| Gọi `kr/claude-sonnet-4.5` | `"2"` | `"2"` |

Đường bền hơn vẫn là **PR ngược lên `github.com/diegosouzapw/OmniRoute`** — dùng
`kiro-dedupe-refreshtoken.patch` + file test kèm theo.

## Test

```bash
npx tsx --test kiroConnectionIdentity.test.ts   # 6/6 pass
```

Test đầu **tái hiện lỗi trên bản gốc** (account 2 khớp nhầm sang hàng account 1); năm test
sau chứng minh bản vá sửa được mà giữ nguyên hành vi cũ, gồm cả ca thật "20 tài khoản chung
ARN ⇒ 20 hàng riêng".

## Không cần vá thì làm gì

agy-proxy đã pool được 20 tài khoản này (khoá theo `(email, target)`). Đo thật: 8 lần gọi
`kr/claude-sonnet-4.5` xoay vòng qua 11 tài khoản khác nhau. Trỏ OmniRoute vào agy-proxy là
ăn được chức năng pool mà không cần vá gì.
