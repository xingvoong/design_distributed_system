FROM node:22-alpine AS base
RUN npm install -g pnpm@9

WORKDIR /app

# Copy manifests first — layer cache only busts when lockfile changes
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/types/package.json           packages/types/
COPY packages/queue/package.json           packages/queue/
COPY packages/leader-election/package.json packages/leader-election/
COPY packages/ai-adapter/package.json      packages/ai-adapter/
COPY services/ai-inference/package.json    services/ai-inference/
COPY services/pipeline-coordinator/package.json services/pipeline-coordinator/
COPY services/worker/package.json          services/worker/

RUN pnpm install --frozen-lockfile

# Copy source and build all packages + services
COPY tsconfig.json ./
COPY packages/ packages/
COPY services/ services/
RUN pnpm -r build
