FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4397 HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY server/ ./server/
COPY docs/ ./docs/
COPY LICENSE ./LICENSE
USER node
EXPOSE 4397
CMD ["node", "server/index.js"]
