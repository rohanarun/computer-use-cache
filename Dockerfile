FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8000 \
    CACHE_DB_PATH=/data/code_model_cache.sqlite3

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

EXPOSE 8000
VOLUME ["/data"]

CMD ["gunicorn", "-b", "0.0.0.0:8000", "server:app"]
