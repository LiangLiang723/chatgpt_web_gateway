# syntax=docker/dockerfile:1.7

FROM mcr.microsoft.com/playwright:v1.62.1-noble AS builder

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable \
    && corepack pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN corepack pnpm build \
    && corepack pnpm prune --prod

FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime

ARG GOOGLE_CHROME_VERSION=151.0.7922.137-1
ARG GOOGLE_CHROME_SHA256=e6dabf044cf9cd0279cfe86efa431682c18bfc06d06339ce055aaa87ae871727

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DATA_DIR=/data \
    HOME=/home/pwuser

RUN sed -i 's|http://azure.archive.ubuntu.com/ubuntu/|http://archive.ubuntu.com/ubuntu/|g' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get -o Acquire::Retries=5 update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        fluxbox \
        gosu \
        novnc \
        websockify \
        x11-utils \
        x11vnc \
    && curl -fsSL --retry 5 \
        -o /tmp/google-chrome-stable.deb \
        "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${GOOGLE_CHROME_VERSION}_amd64.deb" \
    && printf '%s  %s\n' "$GOOGLE_CHROME_SHA256" /tmp/google-chrome-stable.deb | sha256sum -c - \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        /tmp/google-chrome-stable.deb \
    && rm -f /tmp/google-chrome-stable.deb /etc/apt/sources.list.d/google-chrome.list \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY docker/maintenance-browser.mjs ./docker/maintenance-browser.mjs
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/gateway-entrypoint
COPY --chmod=755 docker/start-novnc.sh /usr/local/bin/start-novnc.sh

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/gateway-entrypoint"]
CMD ["node", "dist/index.js"]
