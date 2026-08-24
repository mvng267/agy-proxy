# Làm mới máy production

Xoá sạch dữ liệu cũ trên server, cài lại bản mới nhất, chuyển 400 account từ Mac sang.

## Vì sao làm mới thay vì deploy thường

Đo trên chính máy production: **18/221 credential còn sống (8%)**, riêng Antigravity
**0/100**. Bộ `@edmicro.vn` đã bị Google xoá — `invalid_grant: "Account has been deleted"`.

Giữ chúng lại không chỉ vô ích mà còn **làm chậm**: mỗi request phải thử hàng loạt account
chết trước khi tới cái sống. (Đo trên Mac: 5,56 account/request, có request quét 35 account
trong 195 giây.)

`scripts/deploy-debian.sh` **cố ý không đụng `data/`** — dùng cho cập nhật mã thông thường.
Việc này cần script khác.

## Ba bước

### 1. Làm mới server

```bash
ssh mvng@100.112.240.4
cd ~/agy-proxy          # hoặc thư mục cài đặt
git pull                # lấy chính script này
bash scripts/lam-moi-server.sh
```

Script sẽ: sao lưu → hỏi xác nhận (gõ `XOA`) → dừng dịch vụ → xoá `data/` + `profiles/` +
`~/.omniroute` → kéo mã mới → `npm ci` → cài OmniRoute → **áp bản vá** → khởi động → nghiệm thu.

**Không xoá gì nếu sao lưu hỏng** — đó là chốt an toàn duy nhất, đừng gỡ.

### 2. Chuyển account từ Mac

```bash
# trên máy Mac
bash scripts/chuyen-account.sh mvng@100.112.240.4
```

Chỉ chuyển `accounts.csv` + `credentials.csv`. **Không** chuyển:
- `profiles/` — user-data Chrome hàng GB, gắn với máy sinh ra nó
- `state.db` — log/quota/metrics của Mac, trộn vào production làm bẩn số liệu

### 3. Trên server: khởi động lại và đồng bộ

```bash
node bin/agyproxy.mjs restart
curl -s localhost:7788/api/health              # pool đã nạp chưa
npx tsx scripts/dong-bo-omniroute.mts          # đẩy sang OmniRoute
```

## Bản vá OmniRoute — bắt buộc

Kiro free-tier cấp **chung một `profileArn`** cho mọi tài khoản Google (đo 20/20 account đều
ra `profile/EHGA3GRVQMUK`). Bản gốc OmniRoute dùng ARN đó để phân biệt account, nên nó coi
400 account là **một** và ghi đè lẫn nhau còn 1 hàng.

`scripts/lam-moi-server.sh` tự áp vá. Kiểm lại bất cứ lúc nào:

```bash
node tools/va-omniroute/va-dist.mjs --xem "$(npm root -g)/omniroute"
#   thân hàm : 4 chunk
#   nơi gọi  : 7 chỗ
#   → ĐANG ÁP
```

⚠ **Vá nằm trong `dist/.build` nên mất khi `npm update -g omniroute`.** Cập nhật xong phải
chạy lại `node tools/va-omniroute/va-dist.mjs "$(npm root -g)/omniroute"` rồi khởi động lại.

## Nghiệm thu

```bash
# hai cổng đều sống
curl -s localhost:7788/api/health
curl -s localhost:20128/api/health/ping

# gọi model thật — đây mới là phép đo quyết định, không phải trạng thái xanh trên giao diện
curl -X POST localhost:7788/v1/chat/completions \
  -H "authorization: Bearer <api-key>" -H 'content-type: application/json' \
  -d '{"model":"kr/claude-sonnet-4.5","messages":[{"role":"user","content":"1+1?"}]}'

# số connection hai bên phải khớp
node -e "const{DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(process.env.HOME+'/.omniroute/storage.sqlite',{readOnly:true});
  console.log(db.prepare(\"SELECT provider,COUNT(*) c FROM provider_connections GROUP BY provider\").all())"
```

## Chạy nền (systemd)

Script tự cài. Kiểm và điều khiển:

```bash
systemctl --user status agyproxy omniroute
journalctl --user -u agyproxy -f
systemctl --user restart omniroute
```

⚠ **Service user tắt khi đăng xuất SSH.** Script tự bật linger, nếu hỏng thì chạy tay:

```bash
sudo loginctl enable-linger $USER
```

Chi tiết: [deploy/systemd/README.md](../deploy/systemd/README.md)

## Quay lại nếu hỏng

```bash
tar xzf ~/agyproxy-truoc-khi-lam-moi-<mốc-thời-gian>.tar.gz -C ~
node bin/agyproxy.mjs restart
```
