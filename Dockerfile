# Stage 1: type check + unit tests. If they fail, the build stops and the running version stays online.
FROM node:24-alpine AS test
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run check && npm test && touch /app/.tested

# Stage 2: the actual app, without dev dependencies
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# Docker only builds stages that are used: this line makes the test stage mandatory
COPY --from=test /app/.tested ./.tested
USER node
EXPOSE 7000
CMD ["node", "--experimental-strip-types", "src/server.ts"]
