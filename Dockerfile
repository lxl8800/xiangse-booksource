FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4397 HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node converter/ ./converter/
COPY --chown=node:node server/ ./server/
COPY --chown=node:node docs/ ./docs/
COPY --chown=node:node LICENSE ./LICENSE
USER node
EXPOSE 4397
CMD ["node", "server/index.js"]
