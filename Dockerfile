FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY src/ ./src/
COPY config/ ./config/

VOLUME ["/app/models", "/app/data"]

CMD ["node", "src/index.js"]
