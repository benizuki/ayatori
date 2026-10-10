# The frontend dependencies are compatible with musl, so keep the build stage small.
FROM node:24-alpine AS frontend-builder

WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

#---
FROM python:3.14-slim-trixie AS runtime

COPY --from=ghcr.io/astral-sh/uv:0.11.16 /uv /uvx /bin/

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AYATORI_API_HOST=0.0.0.0 \
    AYATORI_API_PORT=8080 \
    AYATORI_DATA_DIR=/app/data \
    AYATORI_MASTER_DATA_DIR=/app/data/master-data

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project \
    && groupadd --gid 10001 ayatori \
    && useradd --uid 10001 --gid ayatori --no-create-home ayatori

ENV PATH="/app/.venv/bin:$PATH"

COPY backend/ ./backend/
COPY --from=frontend-builder /build/frontend/dist ./frontend/dist

RUN mkdir -p /app/data \
    && chown -R ayatori:ayatori /app/data

USER ayatori

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3)"

CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8080"]
