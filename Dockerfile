# syntax=docker/dockerfile:1.7
#
# One image, three commands.
#
# The app, the worker and the migration step run the same build: they share a
# Prisma client, the same services and the same configuration guard, and
# shipping one artefact is the only way to be sure the thing that migrated the
# database is the thing that will query it.
#
#   default CMD                              the Next.js server
#   node_modules/.bin/tsx src/server/worker/main.ts   the background worker
#   npx prisma migrate deploy                the release step, once per deploy
#
# Debian rather than Alpine on purpose: Prisma's query engine wants OpenSSL,
# and the glibc build is the one Prisma tests most heavily.
ARG NODE_VERSION=22.20.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN npx prisma generate

# Placeholders, used only while compiling. Nothing in this build connects to a
# database: every route is `dynamic = 'force-dynamic'`, so no page is rendered
# at build time. EXPERTOPS_ENV says this is a *build*, not a deployment, which
# is what stops the production configuration guard rejecting the placeholders.
ENV NODE_ENV=production \
    EXPERTOPS_ENV=development \
    DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build_placeholder \
    AUTH_SECRET=build-time-placeholder-never-used-at-runtime
RUN npm run build

# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    NEXT_DIST_DIR=.next-prod \
    PORT=3000

# The full dependency tree, not just production dependencies: the worker runs
# TypeScript through tsx and the release step runs the Prisma CLI, and both are
# devDependencies. Trading image size for "the container can actually do its
# job" is the right way round for a staging box.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next-prod ./.next-prod
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/next.config.ts /app/tsconfig.json ./

USER node
EXPOSE 3000

# Container-local liveness. The reverse proxy in front of this is what testers
# reach; this is what Docker restarts on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The binary, not `npm run start`: npm as PID 1 does not pass SIGTERM on, so a
# `docker stop` would kill the server instead of letting it shut down.
CMD ["node_modules/.bin/next", "start", "--port", "3000"]
