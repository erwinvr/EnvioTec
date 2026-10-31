# syntax=docker/dockerfile:1
# Node.js 26 LTS (Lithium), pinned by version and digest.
FROM node:26.13.0-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Development and tests: includes devDependencies and the test suite.
FROM base AS dev
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY src ./src
COPY tests ./tests
USER node
CMD ["node", "src/server.js"]

# Production: only runtime dependencies, no npm, non-root user.
FROM base AS runtime
ENV NODE_ENV=production
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
