# mcp-voice eval-harness — Python FastAPI sidecar (Gate A stylometry + verdicts).
# Spec 03. Separate runtime service from the TS MCP server; reached only by
# mcp-voice over the internal docker network (no host port).
# Build context = this directory (eval-harness/).

FROM python:3.11-slim

WORKDIR /app

# Runtime dependencies — mirror eval-harness/pyproject.toml [project.dependencies].
# Pinned here (no build backend declared) so `pip install .` packaging is not required.
RUN pip install --no-cache-dir \
    "fastapi>=0.115" \
    "uvicorn>=0.34" \
    "numpy>=2.0" \
    "pydantic>=2.9"

# Application package
COPY evalharness/ ./evalharness/

# Non-root user; bytecode off so a read-only FS never attempts __pycache__ writes.
RUN useradd -m -u 1000 eval && chown -R eval /app
USER eval
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

EXPOSE 8920

LABEL org.opencontainers.image.source=https://github.com/nsoult-agentic/mcp-voice

CMD ["uvicorn", "evalharness.app:app", "--host", "0.0.0.0", "--port", "8920"]
