# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy manifests first for better layer caching
COPY package.json package-lock.json* ./

# Install production deps only
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Install canvas native dependencies (required by @napi-rs/canvas)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    pango-dev \
    libjpeg-turbo-dev \
    giflib-dev \
    librsvg-dev \
    # Alpine ships no fonts, so canvas text (profile, level, captcha, meme)
    # renders blank. Liberation Sans is metric-compatible with Arial.
    font-liberation

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Don't run as root
RUN addgroup -S botgroup && adduser -S botuser -G botgroup && \
    chown -R botuser:botgroup /app
USER botuser

# Health check via the Express server
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget -qO- http://localhost:${PORT:-3001}/health || exit 1

EXPOSE ${PORT:-3001}

CMD ["node", "src/index.js"]
