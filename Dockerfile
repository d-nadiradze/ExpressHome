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

# Prefer IPv6 destinations even though the container only has a ULA (fd00::/8)
# address (Docker NAT66). RFC 6724's default labels make glibc sort IPv4 first
# in that case, which would route every request via the VPS's IPv4 address that
# Cloudflare challenges. Giving fc00::/7 the same label as global IPv6 fixes
# the ordering for everything using getaddrinfo (Node, curl, Chrome). Listing
# any label replaces the whole default table, so all defaults are repeated.
COPY --chown=root:root <<'EOF' /etc/gai.conf
label ::1/128       0
label ::/0          1
label 2002::/16     2
label ::/96         3
label ::ffff:0:0/96 4
label fec0::/10     5
label fc00::/7      1
label 2001:0::/32   7
EOF

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

# Full Chromium (new-headless via PLAYWRIGHT_CHROMIUM_CHANNEL), not the
# headless shell: Cloudflare's managed challenge on ss.ge detects the shell
# and never clears from a datacenter IP, which breaks account linking here
# and token fetches in the worker. --no-shell skips the redundant shell build.
ENV PLAYWRIGHT_CHROMIUM_CHANNEL=chromium
# `chown nextjs /app` (the directory itself, NOT -R): WORKDIR created it as
# root and COPY --chown only owns the files inside. HOME=/app, and full
# Chrome must create $HOME/.config/... for its crashpad database at startup;
# when it cannot, the handler starts without --database and Chrome dies with
# SIGTRAP before loading anything. The headless shell never wrote to $HOME.
RUN node node_modules/playwright-core/cli.js install chromium --no-shell && \
    chown -R nextjs:nodejs /ms-playwright && \
    chown nextjs:nodejs /app && \
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

# Prefer IPv6 with a ULA-only container address — see runner stage.
COPY --chown=root:root <<'EOF' /etc/gai.conf
label ::1/128       0
label ::/0          1
label 2002::/16     2
label ::/96         3
label ::ffff:0:0/96 4
label fec0::/10     5
label fc00::/7      1
label 2001:0::/32   7
EOF

COPY --from=worker-deps --chown=nextjs:nodejs /app/package.json /app/package-lock.json ./
COPY --from=worker-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=worker-deps --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=worker-deps --chown=nextjs:nodejs /app/tsconfig.json ./
COPY --from=worker-deps --chown=nextjs:nodejs /app/src ./src

# Full Chromium in new-headless mode (see runner stage): the headless shell is
# smaller but fails Cloudflare's challenge on ss.ge from the VPS.
# Do NOT chown -R /app here — the COPYs above already own it, and a recursive
# chown would duplicate node_modules into another image layer.
ENV PLAYWRIGHT_CHROMIUM_CHANNEL=chromium
# chown of /app itself (not -R) so Chrome can create $HOME/.config — see runner.
RUN node node_modules/playwright-core/cli.js install chromium --no-shell && \
    chown -R nextjs:nodejs /ms-playwright && \
    chown nextjs:nodejs /app && \
    mkdir -p /app/data/uploads && chown -R nextjs:nodejs /app/data

COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER nextjs

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/worker/prefill-worker.ts"]
