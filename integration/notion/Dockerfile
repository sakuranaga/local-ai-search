FROM python:3.12-slim

WORKDIR /app

COPY requirements.in .
RUN pip install --no-cache-dir -r requirements.in

COPY notion_sync.py .

VOLUME ["/data"]

ENTRYPOINT ["python", "-u", "notion_sync.py"]
