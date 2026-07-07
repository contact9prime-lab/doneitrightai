# Build stage: compile TypeScript with dev dependencies
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

# Runtime stage: production dependencies only
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# /data holds the config, the ledger, and snapshots — mount it from the host
# so the audit trail and recovery state outlive the container.
VOLUME /data
ENV RECOIL_DATA_DIR=/data/.recoil

ENTRYPOINT ["node", "dist/index.js"]
CMD ["/data/recoil.config.json"]
