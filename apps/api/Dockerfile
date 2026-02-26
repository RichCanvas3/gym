FROM python:3.12-slim

WORKDIR /app

COPY apps/api/requirements.txt /app/apps/api/requirements.txt
RUN pip install --no-cache-dir -r /app/apps/api/requirements.txt

COPY . /app

ENV PYTHONUNBUFFERED=1
ENV PORT=8000

CMD ["bash", "-lc", "uvicorn apps.api.main:app --host 0.0.0.0 --port ${PORT}"]

