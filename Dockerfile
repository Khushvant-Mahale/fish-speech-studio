# syntax=docker/dockerfile:1
FROM python:3.11-slim

# Set environment defaults
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DEBIAN_FRONTEND=noninteractive \
    HOST=0.0.0.0 \
    PORT=7865

# Install system dependencies (libsndfile for soundfile, ffmpeg for audio processing, curl for health checks)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Pre-download neural models for instant container startup
COPY download_models.py .
RUN python download_models.py

# Copy application source code
COPY app.py .
COPY colab_worker.py .
COPY colab_fish_worker.py .
COPY convert_epub.py .
COPY generate_prompts.py .
COPY core/ core/
COPY studio/ studio/
COPY voices/ voices/
COPY cli/ cli/

# Create persistent runtime data directories
RUN mkdir -p /app/cache /app/output /app/projects /app/data /app/voices/reference

# Expose default studio port
EXPOSE 7865

# Container health check probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://127.0.0.1:${PORT:-7865}/health || exit 1

# Start Kashva Voice server
CMD ["sh", "-c", "python app.py --host ${HOST:-0.0.0.0} --port ${PORT:-7865}"]
