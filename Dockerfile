# syntax=docker/dockerfile:1
# Stage 1: Build
FROM node:20-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json* ./
# Cache the npm download cache across builds so `npm ci` only re-fetches changed deps.
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
ENV NODE_OPTIONS="--max-old-space-size=2048"
ENV SKIP_BUILD_CHECKS=1
RUN npx prisma generate
# Persist Next.js' incremental build cache (.next/cache) so repeat builds only
# recompile changed modules instead of the whole app.
RUN --mount=type=cache,target=/app/.next/cache mkdir -p public && npm run build

# Stage 2: Production
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --home /app --ingroup nodejs nextjs && \
    apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    libwayland-client0 fonts-noto \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# curl: Cloudflare challenges Node's TLS fingerprint on home.ss.ge from
# datacenter IPs but lets curl through — used as the cheap fallback for
# fetching the ss.ge guest token (see src/lib/ssge-challenge-fetch.ts).
# ca-certificates: node:*-slim ships without a CA bundle; curl cannot do
# TLS without it ("curl: (77) error setting certificate file").

# Standalone output: only the minimal server + needed node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/playwright ./node_modules/playwright
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/playwright-core ./node_modules/playwright-core

# Headless shell only (see worker stage) — saves ~380 MB per image.
RUN node node_modules/playwright-core/cli.js install chromium-headless-shell && \
    chown -R nextjs:nodejs /ms-playwright && \
    mkdir -p /app/data/uploads && chown -R nextjs:nodejs /app/data

COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]

# Stage 3: Worker. Runs the TypeScript sources directly through tsx, so it
# needs src + node_modules, but NOT the Next.js build output or the dev
# toolchain the builder stage carries. Start from a clean base and copy only
# what the worker uses — that keeps the image (and every deploy's pull) far
# smaller than inheriting the whole builder.
#
# The dependency tree is pruned in a throwaway stage first: a layer can only
# add to the image, so deleting packages AFTER copying node_modules would still
# ship the full 950 MB copy layer underneath.
FROM builder AS worker-deps
# Drop dev-only packages (typescript, tailwind, postcss, @types...). tsx,
# prisma and dotenv are runtime deps of the worker and stay. Also remove two
# large packages the worker never loads: Next's SWC compiler binaries (tsx
# compiles with esbuild) and googleapis (only the app's Sheets routes use it).
RUN npm prune --omit=dev && npm cache clean --force && \
    rm -rf node_modules/@next/swc-* node_modules/googleapis

FROM node:20-slim AS worker-runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV HOME=/app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --home /app --ingroup nodejs nextjs && \
    apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    libwayland-client0 fonts-noto \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# ca-certificates + curl: see runner stage — fallback for the
# Cloudflare-challenged ss.ge token page.

COPY --from=worker-deps --chown=nextjs:nodejs /app/package.json /app/package-lock.json ./
COPY --from=worker-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=worker-deps --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=worker-deps --chown=nextjs:nodejs /app/tsconfig.json ./
COPY --from=worker-deps --chown=nextjs:nodejs /app/src ./src

# Only the headless shell: every launch in this codebase is headless in
# Docker, and Playwright uses chromium_headless_shell for headless: true.
# Do NOT chown -R /app here — the COPYs above already own it, and a recursive
# chown would duplicate node_modules into another image layer.
RUN node node_modules/playwright-core/cli.js install chromium-headless-shell && \
    chown -R nextjs:nodejs /ms-playwright && \
    mkdir -p /app/data/uploads && chown -R nextjs:nodejs /app/data

COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER nextjs

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/worker/prefill-worker.ts"]
