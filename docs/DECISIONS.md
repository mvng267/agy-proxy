# Quyết định kiến trúc (ADR)

## 1. Persistent context thay vì storageState
`chromium.launchPersistentContext(profiles/<email>)` với `channel:'chrome'` (Chrome thật).
Lý do: storageState chỉ bê cookie → mất fingerprint/localStorage/IndexedDB, mỗi lần mở là "máy mới".
Persistent context giữ nguyên "một máy từ ngày đầu" — yếu tố số 1 để Google không nghi ngờ.

## 2. Fingerprint: KHÔNG anti-automation spoof, CÓ per-account diversity (coherent)
Phân biệt 2 việc khác nhau:
- **Anti-automation stealth** (giả để giấu là Playwright trên 1 account): KHÔNG làm — bị
  phát hiện ngược, burn account.
- **Per-account fingerprint diversity** (mỗi account trông như 1 thiết bị khác): CÓ làm —
  vì 100 account chạy chung 1 máy sẽ chung canvas/WebGL/UA/screen/cores → Google liên kết.

Cách làm: `fingerprint-generator` + `fingerprint-injector` (Apify), nhưng **ép về macOS +
Chrome desktop** khớp UA/OS/TLS thật của máy → KHÔNG mismatch JA3/JA4/Client Hints (spoof
sang OS khác còn dễ bị bắt hơn không spoof). Mỗi account 1 fingerprint riêng, **CỐ ĐỊNH**
(lưu cột `fingerprint` trong accounts.csv; đổi mỗi lần còn nguy hơn dùng chung). Injector tự
lo `navigator.webdriver`. Vary: WebGL renderer (Apple M1/M2/M4…), screen, cores, RAM, fonts.
Tắt nhanh bằng `FINGERPRINT=false`. Xem [fingerprint.ts](../src/browser/fingerprint.ts).

**BÀI HỌC quan trọng — bắt buộc `slim: true`**: chế độ inject đầy đủ (non-slim, có canvas
noise) làm trang login Google (gaia) báo **"Something went wrong"** → không login được. Phải
dùng `slim: true` (patch nhẹ, KHÔNG canvas noise) thì gaia mới cho qua. Đánh đổi: canvas
fingerprint dùng chung giữa các account, nhưng WebGL/cores/RAM/screen vẫn khác nhau + profile
riêng + proxy riêng vẫn de-link mạnh. `getFingerprint` ép `fingerprint.slim=true` cho cả FP
đã lưu từ trước.

## 3. Intercept redirect thay vì mở callback server
`redirect_uri` của OmniRoute (`localhost:8080/callback`) nằm trong container, không expose ra host.
Playwright `page.route()` chặn điều hướng tới callback, rút `code`, rồi gọi OmniRoute `/exchange`.
Không cần bind port. Áp dụng cho antigravity, gemini-cli, và cả Kiro.

## 4. Kiro chạy PKCE riêng (không qua OmniRoute)
Người dùng cần cầm trực tiếp `refreshToken` để backup. Hằng số lấy từ OmniRoute `KIRO_CONFIG`
+ reference AIClient2API (đã xác minh):
- login `https://prod.us-east-1.auth.desktop.kiro.dev/login?idp=Google&redirect_uri=..&code_challenge=..&code_challenge_method=S256&state=..`
- token `POST /oauth/token {code, code_verifier, redirect_uri}` → `{accessToken, refreshToken, profileArn}`
- refresh `POST /refreshToken {refreshToken}`
Vì intercept (không bind port thật), port 49153 cố định KHÔNG gây kẹt — không cần mutex.

## 5. 1 account = 1 proxy sticky
Tránh "checkpoint chain": nhiều account chung fingerprint/IP → 1 account bị đánh dấu kéo cả cụm.
Timezone/locale ghim cố định theo account. Proxy gán round-robin nhưng không đổi về sau.

## 6. CSV là nguồn lưu chính
Theo yêu cầu backup/portable. `node:sqlite` built-in chỉ giữ state runtime (không compile native).

## 7. Scheduler tuần tự tuyệt đối
Chỉ 1 browser active tại một thời điểm, giãn nhịp ngẫu nhiên 3–10 phút giữa các account,
cap login mới/24h. Fail 1 lần → dừng, không retry mù (retry làm điểm rủi ro tăng vọt).

## Ghi chú vận hành
- Proxy Webshare hiện là **datacenter** (UK) → rủi ro checkpoint cao hơn residential/mobile. Cân nhắc.
- Link download list Webshare có token xoay vòng; nếu 400 "Invalid download token", lấy link mới
  hoặc dán trực tiếp list `ip:port:user:pass`.
- `gemini-cli` phía OmniRoute có thể trả lỗi khi authorize (cần GCP project/onboarding). `gweb` là đường Gemini chắc chắn.
