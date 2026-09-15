FROM node:20-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 needs a C++ toolchain to build its native module.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src ./src
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/coordination.db
EXPOSE 8080
CMD ["node", "dist/src/server.js"]
