FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Select the service at runtime via SERVICE_NAME env var.
# docker-compose sets this per service; the shell exec passes signals to Node.
CMD ["sh", "-c", "exec node dist/services/${SERVICE_NAME}/main.js"]
