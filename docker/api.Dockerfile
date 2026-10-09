# Control-plane API for the local stack: production dependency wiring (server/src/docker.ts) against local emulators.
FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /repo
# Manifests first so dependency installs are cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY server/package.json server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/crypto/package.json packages/crypto/
COPY packages/sync/package.json packages/sync/
RUN pnpm install --frozen-lockfile --filter "@p2platex/server..." --ignore-scripts
COPY packages/protocol packages/protocol
COPY packages/crypto packages/crypto
COPY packages/sync packages/sync
COPY server server
WORKDIR /repo/server
ENV NODE_ENV=development PORT=3000
EXPOSE 3000
USER node
CMD ["node_modules/.bin/tsx", "src/docker.ts"]
