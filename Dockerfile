FROM node:20-alpine AS builder
RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json* ./

# Install ALL deps (including dev) so vite and build tools are available
RUN npm ci

COPY . .

RUN npm run build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

# Install only production deps for the final image
RUN npm ci --omit=dev && npm cache clean --force

# Copy built output and prisma schema from builder
COPY --from=builder /app/build ./build
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/app ./app
COPY --from=builder /app/shopify.app.toml ./shopify.app.toml

EXPOSE 3000

CMD ["npm", "run", "docker-start"]
