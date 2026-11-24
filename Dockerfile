# syntax=docker/dockerfile:1
FROM python:3.11-slim

# Set environment defaults
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DEBIAN_FRONTEND=noninteractive \
    MALLOC_ARENA_MAX=2 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    HOST=0.0.0.0 \
    PORT=7860

# Install system dependencies (libsndfile for soundfile, ffmpeg for audio processing, curl for health checks, espeak-ng for kokoro phonemization)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    curl \
    ca-certificates \
    espeak-ng \
    && rm -rf /var/lib/apt/lists/*

# Set up non-root user for Hugging Face Spaces (UID 1000)
RUN useradd -m -u 1000 user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

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

# Create persistent runtime data directories & set permissions for user 1000
RUN mkdir -p /app/cache /app/output /app/projects /app/data /app/voices/reference && \
    chown -R user:user /app && \
    chmod -R 775 /app

# Switch to non-root user
USER user

# Expose default port
EXPOSE 7860

# Start Kashva Voice server
CMD ["sh", "-c", "python app.py --host ${HOST:-0.0.0.0} --port ${PORT:-7860}"]
