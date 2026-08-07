# Antigravity gateway + dashboard + harvest — full image (kèm Google Chrome)
# Node 24: cần cho node:sqlite (>=22.5). Debian bookworm để cài Chrome deps.
FROM node:24-bookworm-slim

WORKDIR /app

# 1) deps (cache layer) — tsx nằm ở dependencies nên --omit=dev vẫn chạy được
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# 2) Chromium (Playwright bundled) + system deps — hoạt động cả amd64 & arm64.
#    (Google Chrome channel không có bản Linux ARM64.)
RUN npx playwright install --with-deps chromium

# 3) source
COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7788 \
    HEADLESS=true \
    CHROME_NO_SANDBOX=1 \
    BROWSER_CHANNEL=bundled

EXPOSE 7788

# /api/health là endpoint công khai (không cần phiên đăng nhập) nên dùng được ở đây.
# start-period rộng: lần chạy đầu còn nạp pool + mở SQLite, chưa sẵn sàng ngay.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7788/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `npx tsx` làm PID 1 là `npm exec`, KHÔNG phải Node: `docker stop` gửi SIGTERM cho npm,
# npm chết ngay và Node bị giết theo mà chưa kịp flushPersist() → mất state (counter,
# cooldown, enabled) mỗi lần restart container. Chạy Node trực tiếp để nó là PID 1 và
# nhận được tín hiệu.
CMD ["node", "--import", "tsx", "src/index.ts"]
