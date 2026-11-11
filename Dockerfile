# Node.js release line to build and run on. Needs 22.13 or newer.
ARG NODE_VERSION=26

# ── build: compile the TypeScript sources ───────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── dependencies: what the bot needs at run time, without the build tools ───
FROM node:${NODE_VERSION}-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production
WORKDIR /app

# package.json marks the compiled files as ES modules, so it has to come along.
COPY package.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# The database lives in /app/data, which is also where the bot looks by default.
# Created up front and owned by the unprivileged user, so that a fresh volume
# mounted here starts out writable.
RUN mkdir data && chown node:node data
VOLUME /app/data

USER node

# Run node directly rather than through npm, so that the stop signal reaches the
# bot and it can close its connection and database cleanly.
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
