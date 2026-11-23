# 🎙️ Kashva Voice — AI Speech & Voice Drama Studio

> **Production-ready, multi-engine audio drama and voice synthesis studio featuring granular sentence-level model routing, zero-shot voice cloning, cinematic emotion acting, on-device WebGPU rendering, and cloud GPU acceleration.**

![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)
![Docker Ready](https://img.shields.io/badge/docker-ready-2496ED.svg?logo=docker&logoColor=white)
![Multi-Engine](https://img.shields.io/badge/engines-Fish%20%7C%20Kokoro%20%7C%20Edge%20%7C%20ElevenLabs%20%7C%20Cartesia%20%7C%20OpenAI-purple.svg)
![Health Check](https://img.shields.io/badge/healthcheck-%2Fhealth-success.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

---

## 🌟 Overview

**Kashva Voice** transforms written stories, manuscripts, and audio dramas into cinematic audio productions with dialogue-level vocal direction.

### Key Capabilities

* **Multi-Engine Ecosystem**:
  * 🐟 **Fish Speech**: Cinematic voice acting (`Drama 3 Cinema` & `S2.1 Pro`) with zero-shot voice cloning and natural language emotion tags (`[whisper]`, `[screaming in sheer panic]`, `[cold sinister whisper]`).
  * ⚡ **Kokoro 82M**: 100% on-device WebGPU instant rendering with zero queue and zero cloud cost.
  * 🌐 **Microsoft Edge TTS**: 300+ free high-fidelity cloud voices across 80+ languages.
  * ✨ **ElevenLabs**: Industry-standard premier studio narration (`v4 Cinematic`, `v3 Multilingual`, `Flash v2.5`).
  * ⚡ **Cartesia Sonic**: Ultra-low-latency real-time voice synthesis (`Sonic 3.6`, `Sonic 4`).
  * 🤖 **OpenAI Audio**: High-clarity commercial voices (`gpt-4o-mini-tts`, `tts-1`).
* **Sentence-Level Model Routing**: Assign distinct models, voices, and emotion tags to individual sentences within the same project.
* **Context-Aware StoryDirector**: Auto-assigns characters, gender, whisper tags, scream climaxes, and scene transitions from raw manuscripts or EPUB chapters.
* **Studio Master WAV Sticher & ZIP Archive Export**: Render hundreds of sentences with sample-accurate pauses between dialogue turns.

---

## ⚡ Quick Start (Local Development)

### Windows
Double-click:
```cmd
run.bat
```

### macOS & Linux
```bash
chmod +x run.sh
./run.sh
```

### Manual Run
```bash
pip install -r requirements.txt
python download_models.py
python app.py --host 0.0.0.0 --port 7865
```
Open **`http://localhost:7865`** in your browser.

---

## 🐳 Production Deployment

### 1. Docker Compose (Recommended for Self-Hosting)

Clone the repository and run:
```bash
# 1. Create environment file from template
cp .env.example .env

# 2. Launch container in background
docker compose up -d --build
```
Verify the container is healthy:
```bash
docker compose ps
curl http://localhost:7865/health
```

### 2. Standalone Docker Container

```bash
# Build image
docker build -t kashva-voice:latest .

# Run container with persistent volumes
docker run -d \
  --name kashva-voice \
  -p 7865:7865 \
  -v "$(pwd)/projects:/app/projects" \
  -v "$(pwd)/voices/reference:/app/voices/reference" \
  -v "$(pwd)/cache:/app/cache" \
  -v "$(pwd)/output:/app/output" \
  --restart unless-stopped \
  kashva-voice:latest
```

### 3. Google Cloud Run

Deploy as a serverless container with continuous auto-scaling:
```bash
gcloud run deploy kashva-voice \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --port 7865 \
  --memory 2Gi \
  --cpu 2
```

### 4. PaaS Deployment (Render / Railway / Heroku)

The repository includes a ready-to-use `Procfile`:
```text
web: python app.py --host 0.0.0.0 --port $PORT
```
1. Connect your GitHub repository to Render, Railway, or Heroku.
2. The platform will automatically detect the `Procfile` or `Dockerfile`.
3. Set your environment variables (e.g. `PORT`, `STUDIO_TIER`) in the platform dashboard.
4. Set health check path to `/health`.

---

## ⚙️ Environment Variables

Configure these variables via `.env` or your cloud provider's dashboard:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `HOST` | `0.0.0.0` | IP interface to bind to |
| `PORT` | `7865` | Server port (auto-mapped by cloud providers via `$PORT`) |
| `STUDIO_TIER` | `free` | Tier setting (`free` or `pro`) |
| `ELEVENLABS_API_KEY` | *(optional)* | ElevenLabs API key for v3/v4 commercial voices |
| `OPENAI_API_KEY` | *(optional)* | OpenAI API key for gpt-4o-mini-tts voices |
| `CARTESIA_API_KEY` | *(optional)* | Cartesia API key for Sonic 3.6/4 voices |
| `FISH_API_KEY` | *(optional)* | Official Fish Audio Cloud API key |
| `FISH_WORKER_URL` | *(optional)* | Colab/Kaggle Cloud GPU worker URL for Drama 3 / S2.1 Pro |
| `KOKORO_WORKER_URL` | *(optional)* | Remote Kokoro worker URL |

---

## 🩺 Health Check & Monitoring

Kashva Voice includes automated health check endpoints for container orchestrators and uptime monitors:

* **Endpoint**: `GET /health` or `GET /api/health`
* **Response**:
  ```json
  {
    "status": "healthy",
    "service": "Kashva Voice",
    "version": "1.0.0",
    "active_tier": "free",
    "timestamp": 1732371450.123
  }
  ```

---

## 🛠️ REST API Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/health` | `GET` | Container readiness probe & health check |
| `/api/engines` | `GET` | Lists available TTS engines and models |
| `/api/voices` | `GET` | Returns active engine voices (`?engine=fish_s2`, `kokoro`, `edge`, `elevenlabs`, `openai`, `cartesia`) |
| `/api/voices/upload_reference` | `POST` | Uploads reference audio clip (`.wav`, `.mp3`) for zero-shot cloning |
| `/api/voices/reference` | `GET` | Lists uploaded reference voice audio files |
| `/api/synthesize_block` | `POST` | Synthesizes sentence with model, emotion tags & voice reference |
| `/api/export_master` | `POST` | Compiles full story into stitched master WAV with custom pauses |
| `/api/export_zip` | `POST` | Packages individual sentence audio files into a ZIP archive |
| `/api/projects` | `GET` | Lists user story projects |
| `/api/project` | `GET/POST`| Loads or saves project script, cast, and audio states |
| `/api/epub/inspect` | `POST` | Inspects EPUB book structure and chapter list |
| `/api/epub/import` | `POST` | Converts book chapters into Kashva Voice audio projects |

---

## 📄 License

MIT License. Designed and engineered for high-performance audio storytelling.
