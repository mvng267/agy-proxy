# Chạy nền trên server

## agy-proxy — dùng lệnh CLI có sẵn

**Không** viết unit file tay. CLI đã có lệnh tự sinh, và nó điền đúng `AGY_HOME`, `PORT`,
đường dẫn Node — tự viết dễ lệch:

```bash
node bin/agyproxy.mjs service install    # tạo + bật + chạy
node bin/agyproxy.mjs service status
```

Unit nằm ở `~/.config/systemd/user/agyproxy.service` (systemd **user**, không cần sudo).

⚠ Service user mặc định dừng khi người dùng đăng xuất. Cho nó chạy cả khi không ai đăng nhập:

```bash
sudo loginctl enable-linger $USER
```

## OmniRoute — unit trong thư mục này

OmniRoute không có lệnh tương đương, nên dùng `omniroute.service` kèm đây:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/omniroute.service ~/.config/systemd/user/

# Đường dẫn trong file là mặc định — sửa nếu máy khác:
sed -i "s#/home/mvng/.local/lib/node_modules#$(npm root -g)#" ~/.config/systemd/user/omniroute.service
sed -i "s#/home/mvng/.local/node/bin/node#$(command -v node)#" ~/.config/systemd/user/omniroute.service

systemctl --user daemon-reload
systemctl --user enable --now omniroute
systemctl --user status omniroute
```

## Xem log

```bash
journalctl --user -u agyproxy -f
journalctl --user -u omniroute -f
```

## Sau khi `npm update -g omniroute`

Bản vá dedupe nằm trong `dist/.build` nên bị cập nhật ghi đè. Không vá lại thì **400 account
Kiro gộp thành 1**:

```bash
node tools/va-omniroute/va-dist.mjs "$(npm root -g)/omniroute"
node tools/va-omniroute/va-dist.mjs --xem "$(npm root -g)/omniroute"   # phải ra "ĐANG ÁP"
systemctl --user restart omniroute
```
