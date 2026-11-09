# Stage 1: build the web UI. Lockfile install, no install scripts; only dist/ reaches the final image.
FROM node:26.12.1-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY frontend/ ./
RUN npm run build

# Stage 2: the app. No Node runtime, no node_modules.
FROM python:3.15.1-slim@sha256:08275f764e022331c6d3e3ca55d8cce01fa4684b02111adf0445d71806fe7941
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DATA_DIR=/data
RUN useradd --create-home --uid 10001 app && mkdir /data && chown app /data
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
COPY app ./app
COPY --from=web /web/dist ./frontend/dist
USER app
EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]
