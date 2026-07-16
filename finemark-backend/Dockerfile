# ─── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer-cached)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc -p tsconfig.json && \
    mkdir -p dist/utils/Templates && \
    cp src/utils/Templates/*.pdf dist/utils/Templates/

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# pg_dump for database backups
RUN apk add --no-cache postgresql-client

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Uploads/assets directories that the app writes to at runtime
RUN mkdir -p uploads public assets

# Copy static assets (logo, templates, etc.)
COPY assets/ ./assets/
COPY public/ ./public/

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "dist/server.js"]
