# syntax=docker/dockerfile:1.7

FROM python:3.12-slim-bookworm AS api
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
RUN groupadd --system chatcontext \
    && useradd --system --gid chatcontext --home-dir /app --no-create-home chatcontext
COPY --chown=chatcontext:chatcontext backend backend
EXPOSE 8765
USER chatcontext
CMD ["python", "-m", "uvicorn", "backend.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8765"]

FROM node:24-bookworm-slim AS web
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl gosu \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node electron electron
COPY --chown=node:node renderer renderer
COPY --chown=node:node runtime runtime
COPY --chown=node:node web web
COPY scripts/docker-web-entrypoint.sh /usr/local/bin/chat-context-web-entrypoint
RUN chmod 0755 /usr/local/bin/chat-context-web-entrypoint \
    && install -d -o node -g node -m 0700 /var/lib/chat-context
EXPOSE 8080
ENTRYPOINT ["chat-context-web-entrypoint"]
CMD ["node", "web/server.js"]
