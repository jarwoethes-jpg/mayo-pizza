FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./server.mjs

RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 8080
CMD ["node", "server.mjs"]
