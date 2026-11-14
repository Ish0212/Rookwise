FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server/package*.json ./server/
RUN npm ci --omit=dev --prefix server
COPY . .
EXPOSE 3001
CMD ["node", "server/server.js"]
