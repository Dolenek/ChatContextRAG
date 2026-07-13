# syntax=docker/dockerfile:1.7

FROM python:3.9-slim-bookworm AS api
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend backend
EXPOSE 8765
CMD ["python", "-m", "uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8765"]

FROM node:20-bookworm-slim AS web
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY electron electron
COPY renderer renderer
COPY runtime runtime
COPY web web
EXPOSE 8080
CMD ["node", "web/server.js"]
