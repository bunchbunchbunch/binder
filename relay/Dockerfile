# Build: docker build -t binder-relay .
# Run:   docker run -d -p 127.0.0.1:3030:3030 -e RELAY_HOST=0.0.0.0 --env-file relay.env --name binder-relay binder-relay
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY relay.mjs ./
USER node
ENV RELAY_HOST=0.0.0.0 RELAY_PORT=3030
EXPOSE 3030
CMD ["node", "relay.mjs"]
