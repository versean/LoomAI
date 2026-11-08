# Hivemind hub: dashboard + MCP endpoint + conductor, in one container.
FROM node:24-slim

# git powers the brain (every change is a commit, snapshots are tags).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system safe.directory '*'

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=4100 \
    HIVEMIND_DATA_DIR=/data
# The brain repo + SQLite live here. Mount a persistent volume on it.
VOLUME ["/data"]
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -fsS http://localhost:4100/health || exit 1
CMD ["node", "src/server.js"]
