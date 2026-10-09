# Web app for the local stack: production Vite build served by nginx with the same security headers as vercel.json,
# proxying /api (HTTP + WebSocket signaling) to the api service.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/crypto/package.json packages/crypto/
COPY packages/sync/package.json packages/sync/
COPY packages/compile/package.json packages/compile/
COPY packages/github/package.json packages/github/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile --filter "@p2platex/web..." --ignore-scripts
COPY packages packages
COPY apps/web apps/web
ARG VITE_TEXLIVE_URL=
ENV VITE_TEXLIVE_URL=$VITE_TEXLIVE_URL
RUN pnpm --filter @p2platex/web build

FROM nginx:1.27-alpine
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
ENV API_UPSTREAM=api:3000 CSP_CONNECT_EXTRA=
EXPOSE 80
