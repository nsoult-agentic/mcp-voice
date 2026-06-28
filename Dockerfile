# mcp-voice — voice MCP server (Streamable HTTP)
# Multi-stage build: install production deps → slim runtime image.
# Deployed via GitHub Actions → ghcr.io → Portainer CE GitOps polling.

# ── Build stage ──────────────────────────────────────
FROM oven/bun:1.3.10-alpine AS build

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production

# ── Production stage ─────────────────────────────────
FROM oven/bun:1.3.10-alpine

WORKDIR /app

# Production artifacts only
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

# Non-root user for defense-in-depth
USER bun

EXPOSE 8919

# Auto-link ghcr.io package to repo
LABEL org.opencontainers.image.source=https://github.com/nsoult-agentic/mcp-voice

CMD ["bun", "run", "src/http.ts"]
