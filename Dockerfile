FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
USER node
EXPOSE 7000
CMD ["node", "--experimental-strip-types", "src/server.ts"]
