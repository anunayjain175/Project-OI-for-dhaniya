FROM python:3.11-slim

# Prevent writing pyc files and buffering stdout
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
# Tell the app we're running on Render so it binds to 0.0.0.0
ENV RENDER=true

WORKDIR /app

# Install build dependencies for postgres client libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Render sets $PORT automatically; default to 8000 for local Docker runs
EXPOSE ${PORT:-8000}

CMD ["python", "backend/main.py"]
