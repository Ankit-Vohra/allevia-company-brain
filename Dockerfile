# Allevia: the API and the built web app on one port (spec §11). Three stages:
#   web   builds web/ (Vite + React) into web/dist
#   deps  installs the server's production dependencies for Linux (sharp, onnxruntime, the Agent SDK's native CLI)
#   app   the runtime: Node 24, the source run with tsx (as in development), web/dist, no data and no secrets
#
# Nothing private is baked in: data/, models/, .env and ~/.config/allevia stay outside the image (see .dockerignore).
# The graph lives in FalkorDB (docker-compose.yml); company data, Studio assets and caches go to the /data volume;
# the local embedding model is mounted read-only at /models when you have it (search is full-text only without it).
#
#   docker build -t allevia .
#   docker build -t allevia --build-arg WITH_CHROMIUM=1 .   # adds Chromium for onboarding from a website URL
#
# The agents run on the Claude Agent SDK with a claude.ai subscription login, never an API key (src/agent/sdk-env.ts
# strips ANTHROPIC_API_KEY and the runtime stops if the SDK reports an API-key source). A container without a login
# serves the public read-only demo (ALLEVIA_PUBLIC_MODE=1): the graph explorer, insights, approvals history and
# replays of recorded showcase turns. README.md "Run it" explains live mode.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------- web: build the single-page app ----------
FROM ${NODE_IMAGE} AS web
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund
# the web app imports shared/contracts.ts and shared/roster.ts through the @shared alias
COPY shared ./shared
COPY web ./web
RUN cd web && npm run build

# ---------- deps: server dependencies, production only ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------- app: the runtime ----------
FROM ${NODE_IMAGE} AS app
ARG WITH_CHROMIUM=0
ARG TSX_VERSION=4.23.15
WORKDIR /app

# tsx runs the TypeScript source directly (the CLI discovers its commands as .ts files); pinned to package-lock.json
RUN npm install -g "tsx@${TSX_VERSION}" --no-audit --no-fund && npm cache clean --force

COPY --from=deps /app/node_modules ./node_modules
# Chromium for the website crawler (onboarding from a URL). Off by default: the public demo never crawls.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN if [ "$WITH_CHROMIUM" = "1" ]; then npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*; fi

COPY package.json tsconfig.json ./
COPY shared ./shared
COPY src ./src
COPY scripts ./scripts
COPY vendor ./vendor
COPY skills ./skills
# scripts/seed-demo.ts builds the synthetic demo company from this fixture (no model needed)
COPY tests/fixtures/seed-graph.ts ./tests/fixtures/seed-graph.ts
COPY --from=web /app/web/dist ./web/dist

# transformers.js keeps a small file cache inside its package; the app runs as `node`, so that folder must be writable
RUN mkdir -p /data /models /home/node/.claude node_modules/@huggingface/transformers/.cache \
 && chown -R node:node /data /home/node node_modules/@huggingface/transformers/.cache

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    ALLEVIA_DATA_DIR=/data \
    ALLEVIA_MODELS_DIR=/models \
    ALLEVIA_ENV_FILE=/dev/null \
    ALLEVIA_FALKORDB_URL=redis://falkordb:6379

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["tsx", "src/cli.ts"]
CMD ["serve"]
