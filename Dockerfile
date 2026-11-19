# Production image for Dokploy / Docker hosts.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies separately for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

EXPOSE 3000
CMD ["node", "server.js"]
