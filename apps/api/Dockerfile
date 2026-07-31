# Build from the monorepo root: docker build -f apps/api/Dockerfile .
FROM node:20-alpine AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/signal-core/package.json packages/signal-core/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci --ignore-scripts
COPY packages/contracts packages/contracts
COPY packages/signal-core packages/signal-core
COPY apps/api apps/api
RUN npm run build --workspace @flippars/contracts \
 && npm run build --workspace @flippars/signal-core \
 && npm run build --workspace @flippars/api

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
RUN addgroup -S flippars && adduser -S -G flippars flippars
COPY --from=build --chown=flippars:flippars /workspace/package.json /workspace/package-lock.json ./
COPY --from=build --chown=flippars:flippars /workspace/node_modules ./node_modules
COPY --from=build --chown=flippars:flippars /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=flippars:flippars /workspace/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=flippars:flippars /workspace/packages/signal-core/dist ./packages/signal-core/dist
COPY --from=build --chown=flippars:flippars /workspace/packages/signal-core/package.json ./packages/signal-core/package.json
COPY --from=build --chown=flippars:flippars /workspace/apps/api/dist ./apps/api/dist
COPY --from=build --chown=flippars:flippars /workspace/apps/api/src/db/migrations ./apps/api/dist/src/db/migrations
COPY --from=build --chown=flippars:flippars /workspace/apps/api/package.json ./apps/api/package.json
USER flippars
EXPOSE 8080
WORKDIR /workspace/apps/api
CMD ["node", "dist/src/server.js"]
