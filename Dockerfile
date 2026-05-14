# Build stage
FROM node:20-alpine AS builder
WORKDIR /usr/src/app

# Install dependencies first so Docker cache works
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY . ./

# Build web and server artifacts
RUN npm run build

# Runtime stage
FROM node:20-alpine AS runner
WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/package.json ./package.json
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/dist-server ./dist-server
COPY --from=builder /usr/src/app/public ./public
COPY --from=builder /usr/src/app/.env.example ./.env.example

ENV NODE_ENV=production
ENV APP_PUBLIC_URL=https://chatbot.salontukawa.com
ENV CONTEXT_CACHE_SERVER_PORT=8080
EXPOSE 8080

CMD ["node", "dist-server/server/index.js"]
