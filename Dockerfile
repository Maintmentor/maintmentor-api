FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

# Cloud Run sets PORT env var
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
