# agy-proxy

OpenAI-compatible gateway that pools Antigravity / Kiro (Claude) accounts behind a single
`/v1` endpoint, with a React dashboard for monitoring and management.

## Architecture

```
src/                  TypeScript backend (tsx src/index.ts)
  proxy/              OpenAI-compatible /v1 request handling
  gateway/            Provider abstraction (Antigravity, Kiro), account pool, rotation
    providers/        Per-provider implementations
  health/             Account health probing (token / live checks)
  browser/            Headless browser automation for login / captcha
  queue/              Request queue + rate-limit pacing
  flows/              Login / warmup / wakeup flows
  omniroute/          Đẩy credential sang OmniRoute (gateway thứ hai)
  store/              Persistence (accounts, state)
  tools/              CLI tooling (bin/agyproxy.mjs)
  lib/                Shared utilities (logger, etc.)
web/                  React + TypeScript dashboard (Vite)
  src/
    components/       UI components
    components/pages/  Dashboard pages (Overview, Pool, Models, Combo, ...)
    components/ui/     shadcn/ui primitives
scripts/              Dev / ops scripts
test/                 Test suites
```

## Agent Skills

This repo ships curated agent skills in `skills/`. **When modifying code, load the matching
skill first** (read `skills/<name>/SKILL.md`):

| Task | Skill |
|------|-------|
| **Vận hành pool đang chạy** (lỗi, chậm, hết quota) | **`operate-agyproxy`** |
| Fix a bug | `diagnosing-bugs` |
| Build a feature | `implement` + `tdd` |
| Review changes | `code-review` |
| Improve architecture | `improve-codebase-architecture` |
| Resolve merge conflict | `resolving-merge-conflicts` |
| Design a module | `codebase-design` / `domain-modeling` |
| Triage an issue | `triage` |
| Set up git hooks | `setup-pre-commit` |

## Build & Verify

```bash
npm install
npm run typecheck        # tsc --noEmit on backend
npm run dev              # tsx watch src/index.ts
npm test                 # backend tests

cd web
npm install
npm run build            # tsc -b && vite build && cp src/login.html dist/login.html
npm run dev              # vite dev server
```

## Conventions

- Backend: TypeScript strict mode, ESM. Use `src/lib/logger.ts` (not `console.log`).
- Web: React 19 + shadcn/ui + Tailwind v4. Dark theme (slate-950 base, orange accent).
- Dashboard login endpoint: `POST /api/auth/login` (NOT `/auth/login`).
- Combo targets are `[{ model, weight? }]`, not `string[]`.
- Commit small, descriptive messages. Do NOT push without review.

## OmniRoute

agy-proxy đẩy credential sang OmniRoute (gateway thứ hai, cổng 20128). Bật bằng cách đặt
**Mật khẩu OmniRoute** ở Cấu hình → OmniRoute; để trống là tắt hẳn. Đồng bộ tự chạy sau mỗi
lần đăng nhập và định kỳ theo `omnirouteSyncMin`.

```bash
npx tsx scripts/dong-bo-omniroute.mts        # chạy tay khi cần
```

⚠ **Sau mỗi lần `npm update -g omniroute` phải vá lại:**

```bash
node tools/va-omniroute/va-dist.mjs --xem    # bản vá còn áp không
node tools/va-omniroute/va-dist.mjs          # vá lại, rồi khởi động lại OmniRoute
```

Không vá thì OmniRoute gộp cả 20 account Kiro thành **1 connection** — nó dedupe theo
`profileArn`, mà Kiro free-tier cấp chung một ARN cho mọi tài khoản Google.

## Đăng nhập fail — đọc screenshot trước

Khi flow đăng nhập trả `failed`, **mở ảnh trước khi đoán nguyên nhân**:

```bash
ls -t ~/.agyproxy/screenshots/ | head    # <email>_<flow>_*_no_code_*.png
```

Ảnh nói thẳng, và ba nguyên nhân dưới đây cần ba cách xử lý khác hẳn nhau:

| Ảnh cho thấy | Nghĩa là | Làm gì |
|---|---|---|
| *"Account deleted"* | Tài khoản bị xoá khỏi Workspace | `npx tsx scripts/danh-dau-tk-chet.mts <khoảng>` rồi nhờ admin khôi phục. Chạy lại vô ích. |
| *"Enter a password"*, ô trống | Profile Chrome hỏng | `mv ~/.agyproxy/profiles/<dir> <dir>.hong-$(date +%H%M)` rồi chạy lại |
| Trang chặn của Google/Kiro | Chặn thật | Dừng đợt, đợi hết chặn |

Đừng đổ tại "Google chặn" khi chưa xem ảnh — đã có lần 106 credential thiếu bị quy cho chặn
tạm thời, hoá ra 94 trong số đó thuộc 47 tài khoản đã bị xoá hẳn, còn tài khoản khác vẫn
đăng nhập bình thường cùng lúc.

Không xoá profile để thử lại — đổi tên, để còn khôi phục.
