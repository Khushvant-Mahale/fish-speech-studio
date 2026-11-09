# 🐟 Fish Audio S2 Pro Story Studio

> **A professional multi-voice audio drama & cinematic storytelling studio powered by the Fish Audio S2 Pro Dual-Autoregressive Neural Engine (`fishaudio/s2-pro`) with Zero-Shot Voice Cloning, 15,000+ Inline Natural-Language Emotion Tags, and Free Google Colab GPU acceleration.**

![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)
![Fish Audio S2 Pro](https://img.shields.io/badge/engine-Fish%20Audio%20S2%20Pro-emerald.svg)
![Dual-AR 4.4B](https://img.shields.io/badge/architecture-Dual--AR%20(4B%2B400M)-purple.svg)
![Zero-Shot Cloning](https://img.shields.io/badge/voice-Zero--Shot%20Reference-orange.svg)
![Acoustics](https://img.shields.io/badge/audio-24kHz--High--Fidelity-emerald.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

---

## 🌟 Overview

**Fish Audio S2 Pro Story Studio** transforms written horror, survival, and cinematic manuscripts into immersive, spine-chilling audio dramas. Built for authors, YouTube storytellers, and audio drama creators, it features:

* **Zero-Shot Voice Cloning**: Clone any voice actor, narrator, or entity from a brief 3–10s audio reference clip (`.wav` / `.mp3`).
* **15,000+ Natural-Language Emotion & Acting Tags**: Direct character performance in plain English (`[whispering in breathy terror]`, `[screaming frantically in sheer panic]`, `[cold, guttural, sinister demonic whisper]`, `[gasping, breath ragged]`).
* **Dual-Engine Flexibility**:
  * **🐟 Fish Audio S2 Pro**: High-fidelity cinematic voice acting via Colab T4/A100 GPU or Fish Audio Cloud API.
  * **⚡ Kokoro ONNX**: Fast local CPU draft inference for script pacing and timing verification.
* **Context-Aware StoryDirector**: Automatically identifies speaker gender, character quotes, whisper tags, scream climaxes, and scene transitions, assigning appropriate acting directions and inter-sentence breath pauses.
* **Master WAV Sticher & ZIP Archive Export**: Render 500+ sentences with sample-accurate pauses between dialogue turns.

---

## ⚡ Quick Start

### 1. Launch the Studio
Double-click:
```cmd
run.bat
```
Or manually run:
```bash
python app.py --port 7865
```
Open **`http://localhost:7865`** in your browser!

---

## 🚀 Connecting Cloud GPU Acceleration (Google Colab T4)

Fish Audio S2 Pro runs at **~0.3s per sentence** using a free Google Colab Tesla T4 GPU:

1. Open a new notebook at [Google Colab](https://colab.research.google.com).
2. Go to **Runtime → Change runtime type** and select **T4 GPU**.
3. In Fish Speech Studio, click **⚙️ Cloud GPU** in the top bar.
4. Click **📋 Copy S2 Pro Worker**.
5. Paste the code into a cell in Colab and click **Run**.
6. Copy the generated Cloudflare URL:
   ```text
   🚀 CLOUD GPU TUNNEL ACTIVE: https://xxxx.trycloudflare.com
   ```
7. Paste it into the Cloud GPU modal in the studio and click **Save & Activate**!

*(Alternatively, paste your official Fish Audio API key from [fish.audio](https://fish.audio) in settings to run directly via the Cloud API without needing Colab!)*

---

## 🎭 S2 Pro Emotion & Acting Tags

You can type any acting instruction inside brackets or click the **Emotion Quick-Chips** in the Left Inspector:

| Tag | Acoustic Effect | Typical Use Cases |
| :--- | :--- | :--- |
| `[whispering in breathy terror]` | Intimate, hushed, secretive tone | Horror suspense, hiding in closets |
| `[screaming frantically in sheer panic]` | Full adrenaline, voice distortion | Zombie encounters, jump scares |
| `[tense, breathless, urgent whisper]` | Fast-paced survival dialogue | Escape sequences, tactical communication |
| `[cold, guttural, sinister demonic whisper]` | Low vocal fry, inhuman presence | Monsters, paranormal entities, villains |
| `[gasping, ragged breath, trembling]` | Heavy breathing, physical exhaustion | Running from pursuers, injured characters |
| `[slow, deep dramatic horror narration]` | Resonant, authoritative pacing | Episode intros, eerie cliffhangers |

---

## 📁 Repository Structure

```text
fish-speech-studio/
├── app.py                     # Main Aiohttp Web Studio backend & API router
├── colab_fish_worker.py       # S2 Pro Cloud GPU worker for Google Colab
├── colab_worker.py            # Kokoro ONNX remote GPU worker fallback
├── run.bat                    # 1-Click Windows execution pipeline (Port 7865)
├── requirements.txt           # Python dependencies
├── core/
│   ├── fish_engine.py         # Fish Audio S2 Pro inference & zero-shot cloning engine
│   ├── fish_voices_metadata.json # Curated horror & cinematic character archetypes
│   ├── kokoro_engine.py       # Local ONNX CPU draft engine
│   ├── project_manager.py     # StoryDirector, sentence splitting & merge logic
│   ├── audio_dsp.py           # Optional post-processing DSP filters
│   └── voices_metadata.json   # Kokoro base voice catalogue
├── studio/
│   ├── index.html             # Studio interface with emotion chips & engine selector
│   ├── css/
│   │   └── studio.css         # Modern studio styling & dark horror aesthetics
│   └── js/
│       └── app.js             # Studio transport, batch render & inspector logic
├── voices/
│   └── reference/             # Uploaded zero-shot character audio reference clips (.wav)
├── projects/                  # Stored story projects (.json)
└── output/                    # Stitched Master WAV exports & ZIP sentence archives
```

---

## 🛠️ REST API Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/voices` | `GET` | Returns active engine voices (`?engine=fish_s2` or `?engine=kokoro`) |
| `/api/voices/upload_reference` | `POST` | Uploads reference audio clip (`.wav`, `.mp3`) for zero-shot cloning |
| `/api/voices/reference` | `GET` | Lists uploaded reference voice audio files |
| `/api/synthesize_block` | `POST` | Synthesizes sentence with S2 Pro emotion tag & reference voice |
| `/api/auto_direct` | `POST` | Auto-detects characters, whispers, screams & emotional pacing |
| `/api/merge_short` | `POST` | Merges consecutive ultra-short fragments of the same voice |
| `/api/split_text` | `POST` | Splits story manuscript into directed sentences |
| `/api/export_master` | `POST` | Compiles full story into stitched master WAV with custom pauses |
| `/api/export_zip` | `POST` | Packages individual sentence audio files into a ZIP archive |
| `/api/config` | `GET/POST`| Manages Colab GPU tunnel URL & Fish Audio API Key |
| `/api/test_remote` | `POST` | Verifies remote Colab GPU worker connection |
| `/api/colab_script` | `GET` | Serves Colab worker script (`?engine=fish_s2` or `?engine=kokoro`) |
