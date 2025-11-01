# Multi-stage build for Site Studio (frontend + backend in one container)

FROM node:20-slim AS builder
WORKDIR /app

# Install dependencies (leverage cache)
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/package.json
COPY packages/frontend/package.json packages/frontend/package.json
COPY packages/worker/package.json packages/worker/package.json
RUN npm ci

# Copy full workspace and build
COPY . .
RUN npm run build

# Prune dev dependencies for runtime
RUN npm prune --omit=dev --workspaces

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy built artifacts and runtime deps
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/backend/templates ./packages/backend/templates
COPY --from=builder /app/packages/frontend/build ./packages/frontend/build

# Default port (overridden by platform as needed)
ENV PORT=3001

EXPOSE 3001

CMD ["node", "packages/backend/dist/index.js"]

