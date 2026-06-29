# ── Build stage ─────────────────────────────────────────────────────────────
# Installs all dependencies and compiles every service and lib into dist/.
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
# Copies only production node_modules and the compiled dist/ tree.
# Each container overrides CMD to start its own service; the proto files and
# compiled JS for all services are present so one image covers all of them.
FROM node:20-alpine AS runner
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
