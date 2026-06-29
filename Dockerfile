# syntax=docker/dockerfile:1

###############################################################################
# Stage 1 — Builder: install all deps and compile every library and service.
###############################################################################
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies (including devDependencies — needed for the build step).
COPY package*.json ./
RUN npm ci

# Copy the full source tree.
COPY . .

# Compile every NestJS project in the monorepo.  Output lands in dist/.
RUN npm run build

###############################################################################
# Stage 2 — Runner: copy only the compiled output and production deps.
###############################################################################
FROM node:20-alpine AS runner

# dumb-init forwards signals (SIGTERM / SIGINT) from Docker to Node correctly,
# so the NestJS shutdown hooks run and spans are flushed on container stop.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy the compiled dist tree.
COPY --from=builder /app/dist ./dist

# Copy node_modules from the builder so we don't have to re-install.
# (Only runtime deps matter here; devDeps are needed because tsconfig-paths
# is a devDep but also the runtime path-resolution mechanism in this monorepo.)
COPY --from=builder /app/node_modules ./node_modules

# Path-registration shim: registers @signalman/* → dist/libs/* before main.
COPY --from=builder /app/docker-start.js ./docker-start.js

ENV NODE_ENV=production

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
# Default to the gateway; docker-compose overrides this CMD per service.
CMD ["node", "docker-start.js"]
