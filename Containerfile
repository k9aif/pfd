FROM docker.io/library/python:3.12-slim

RUN useradd --create-home --uid 1000 app
WORKDIR /app
COPY server.py ./
COPY static ./static

ENV HOST=0.0.0.0 PORT=8095 DATA_DIR=/data PYTHONUNBUFFERED=1
RUN mkdir -p /data && chown app:app /data
USER app
VOLUME ["/data"]
EXPOSE 8095

HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8095/healthz', timeout=4)"
CMD ["python", "server.py"]
