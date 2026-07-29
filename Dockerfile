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
CMD ["npx", "tsx", "src/index.ts"]
