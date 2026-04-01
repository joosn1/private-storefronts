FROM node:20-alpine
RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json* ./

# Install all deps (including dev) so build tools like vite are available
RUN npm ci

COPY . .

# Generate Prisma client before building so it's available in the server bundle
RUN npx prisma generate

# Build the app
RUN npm run build

EXPOSE 3000

# docker-start runs: prisma generate && prisma migrate deploy && react-router-serve
CMD ["npm", "run", "docker-start"]
