# ---- Build the Astro frontend ---------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Install server runtime deps ------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ---- Runtime --------------------------------------------------------------
FROM node:22-alpine
ARG GIT_REVISION
ENV NODE_ENV=production

# Layout: /app/server (cwd) serves ../web/dist
WORKDIR /app/server
COPY --from=deps /server/node_modules ./node_modules
COPY server/ ./
COPY --from=web /web/dist /app/web/dist

# The platform (e.g. DigitalOcean) provides PORT and the PG_*/BSKY_* env vars.
EXPOSE 8000
CMD ["npm", "run", "start"]
