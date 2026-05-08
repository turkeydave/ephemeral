FROM node:20-alpine

WORKDIR /app

# Install dependencies into the image. The source tree is bind-mounted at
# runtime, but the anonymous volume on /app/node_modules in docker-compose
# preserves these installed deps.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js ./

CMD ["node", "index.js"]
