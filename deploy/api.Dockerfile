# One image for the API, the worker and one-off operations (migrations, provision:store).
# Build context: the repository root at the commit being deployed (git archive), never a working copy.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && npx prisma generate && npx tsc

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# Dev dependencies stay: the Prisma CLI runs migrations and provision:store from this image.
COPY --from=build --chown=node:node /app /app
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA
USER node
EXPOSE 4000
CMD ["node", "dist/apps/api/src/main.js"]
