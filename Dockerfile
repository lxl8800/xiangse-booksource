# Pinned multi-architecture Node base; update explicitly after tests, not at deploy time.
ARG NODE_IMAGE=node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
ENV NODE_ENV=production PORT=4397 HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM dependencies AS application
COPY --chown=node:node converter/ ./converter/
COPY --chown=node:node server/ ./server/
COPY --chown=node:node docs/ ./docs/
COPY --chown=node:node LICENSE ./LICENSE
COPY tools/build-info.mjs /tmp/build-info.mjs
ARG BUILD_REVISION=unknown
ARG APP_VERSION=development
RUN BUILD_REVISION="$BUILD_REVISION" node /tmp/build-info.mjs > /app/build-info.json \
    && chmod -R a+rX /app/converter /app/server /app/docs \
    && rm /tmp/build-info.mjs
LABEL org.opencontainers.image.title="Xiangse Booksource" \
      org.opencontainers.image.version="$APP_VERSION" \
      org.opencontainers.image.revision="$BUILD_REVISION"

# All test assets live here, never in the final production image.
FROM application AS test
COPY --chown=node:node tests/ ./tests/
COPY --chown=node:node test-data/ ./test-data/
COPY --chown=node:node tools/ ./tools/
RUN npm ci --prefix tests --include=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
USER node
ENV NODE_ENV=test
CMD ["npm", "run", "test:all"]

# Keep the default target a single lightweight serving container.
FROM application AS production
RUN rm -rf /app/server/tests /app/converter/test
USER node
EXPOSE 4397
CMD ["node", "server/index.js"]
