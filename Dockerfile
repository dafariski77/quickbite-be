# --- Stage 1: Build specific Nx app ---
FROM node:22-alpine AS builder

ARG APP_NAME=core-app
WORKDIR /workspace

# Install workspace dependencies (ignoring lifecycle scripts until schema and config are copied)
COPY package*.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/core-app/package.json ./apps/core-app/
COPY apps/core-app-e2e/package.json ./apps/core-app-e2e/

RUN npm ci --ignore-scripts

# Copy monorepo source and build target app
COPY . .

# Generate Prisma client using prisma.config.ts
RUN npx prisma generate

# Build the specified app
RUN npx nx build ${APP_NAME} --configuration=production

# Prune dev dependencies for lean production runtime
RUN npm prune --omit=dev && npx prisma generate

# --- Stage 2: Minimal production runtime ---
FROM node:22-alpine AS runner

ARG APP_NAME=core-app
ENV NODE_ENV=production
WORKDIR /app

# Copy production node_modules and built app from builder
COPY --from=builder --chown=node:node /workspace/node_modules ./node_modules
COPY --from=builder --chown=node:node /workspace/apps/${APP_NAME}/dist ./

USER node

EXPOSE 3007

CMD ["node", "main.js"]
