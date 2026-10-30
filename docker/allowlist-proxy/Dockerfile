FROM node:22-bookworm-slim
WORKDIR /app
COPY allowlist-proxy.cjs /app/allowlist-proxy.cjs
EXPOSE 8080
ENTRYPOINT ["node", "/app/allowlist-proxy.cjs"]
