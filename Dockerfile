# Single container: API + worker (src/main.ts), with ffmpeg for stitching.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY public ./public
EXPOSE 3000
# Applies pending migrations, then starts the API and the worker. `exec` makes node PID 1 so it receives
# SIGTERM on deploys and finishes running jobs before exiting (npm would not forward the signal).
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/main.js"]
