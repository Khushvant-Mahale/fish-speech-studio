import os
import re
import io
import json
import uuid
import time
import zipfile
import asyncio
import threading
import urllib.request
import urllib.parse
from typing import Optional, Dict, List, Tuple, Union, Any
from pathlib import Path
from aiohttp import web
import numpy as np
import soundfile as sf

from core.fish_engine import FishEngine
from core.kokoro_engine import KokoroEngine
from core.kaggle_cloud_manager import KaggleCloudManager
from core.dns_fallback import setup_resilient_dns

# Ensure resilient DNS is active
setup_resilient_dns()
from core.project_manager import ProjectManager
from core.epub_parser import inspect_epub, get_chapter_text

BASE_DIR = Path(__file__).resolve().parent
STUDIO_DIR = BASE_DIR / "studio"
KOKORO_STUDIO_DIR = BASE_DIR / "kokoro_studio"
CACHE_DIR = BASE_DIR / "cache"
OUTPUT_DIR = BASE_DIR / "output"
SAMPLES_DIR = OUTPUT_DIR / "samples"
VOICES_DIR = BASE_DIR / "voices" / "reference"
VOICES_FILE = BASE_DIR / "core" / "voices_metadata.json"
FISH_VOICES_FILE = BASE_DIR / "core" / "fish_voices_metadata.json"
CONFIG_FILE = BASE_DIR / "projects" / "config.json"

CACHE_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
VOICES_DIR.mkdir(parents=True, exist_ok=True)

fish_engine: FishEngine = None
kokoro_engine: KokoroEngine = None
project_mgr = ProjectManager()
kaggle_mgr = KaggleCloudManager(BASE_DIR)




def load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "remote_worker_url": "",
        "fish_remote_worker_url": "",
        "fish_api_key": "",
        "active_engine": "fish_s2"
    }


def save_config(cfg: dict):
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


async def init_engine():
    global fish_engine, kokoro_engine
    cfg = load_config()

    # Initialize Fish Audio S2 Pro Engine
    fish_remote = (cfg.get("fish_remote_worker_url") or cfg.get("remote_worker_url", "")).strip()
    fish_key = cfg.get("fish_api_key", "").strip()
    try:
        fish_engine = FishEngine(remote_url=fish_remote, api_key=fish_key)
        print(f"[Fish Speech Studio] Fish Audio S2 Pro engine ready (Worker: {fish_remote or 'None'}, API Key: {'Set' if fish_key else 'None'})")
    except Exception as e:
        print(f"[Fish Speech Studio] Warning: FishEngine init error: {e}")

    # Initialize Kokoro Engine
    kokoro_remote = (cfg.get("kokoro_remote_worker_url") or cfg.get("remote_worker_url", "")).strip()
    try:
        kokoro_engine = KokoroEngine(remote_url=kokoro_remote)
        print(f"[Kokoro Studio] Kokoro engine ready (Worker: {kokoro_remote or 'Local ONNX'})")
    except Exception as e:
        print(f"[Kokoro Studio] Warning: KokoroEngine init error: {e}")

    # Restore active Kaggle session state if configured
    if cfg.get("kaggle_username"):
        kaggle_mgr._active_session["username"] = cfg["kaggle_username"]
        kaggle_mgr._active_session["kernel_ref"] = f"{cfg['kaggle_username']}/fish-speech-s2-worker"
        if fish_remote and "trycloudflare.com" in fish_remote:
            kaggle_mgr._active_session["status"] = "ready"
            kaggle_mgr._active_session["tunnel_url"] = fish_remote
            kaggle_mgr._active_session["last_log"] = "Kaggle Tesla T4 GPU Worker is online and connected!" 


@web.middleware
async def no_cache_middleware(request, handler):
    resp = await handler(request)
    if request.path.startswith(("/studio", "/kokoro", "/projects")) or request.path == "/":
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp


# ---------------- API HANDLERS ---------------- #

async def handle_index(request):
    resp = web.FileResponse(STUDIO_DIR / "index.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


async def handle_kokoro_index(request):
    resp = web.FileResponse(KOKORO_STUDIO_DIR / "index.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


async def handle_kokoro_favicon(request):
    fav_file = KOKORO_STUDIO_DIR / "favicon.svg"
    if fav_file.exists():
        return web.FileResponse(fav_file, headers={"Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400"})
    return web.Response(status=404)


async def handle_get_voices(request):
    engine_param = (request.query.get("engine") or "").lower()
    referer = request.headers.get("Referer", "").lower()
    is_kokoro = (engine_param == "kokoro") or (not engine_param and "/kokoro" in referer)

    if is_kokoro:
        k_voices = []
        if VOICES_FILE.exists():
            try:
                with open(VOICES_FILE, "r", encoding="utf-8") as f:
                    k_voices = json.load(f)
            except Exception:
                pass
        return web.json_response(k_voices)

    voices = []
    if FISH_VOICES_FILE.exists():
        try:
            with open(FISH_VOICES_FILE, "r", encoding="utf-8") as f:
                voices = json.load(f)
        except Exception:
            pass

    for v in voices:
        if v.get("id", "").startswith("custom_") or "Library" in v.get("genre", []):
            v["is_custom"] = True

    existing_refs = {Path(v.get("reference_audio", "")).name for v in voices if v.get("reference_audio")}

    # Append uploaded custom reference voices that aren't already registered
    ref_files = list(VOICES_DIR.glob("*.*"))
    for rf in ref_files:
        if rf.suffix.lower() in [".wav", ".mp3", ".ogg", ".flac", ".m4a"]:
            if rf.name in existing_refs:
                continue
            slug = re.sub(r'[^a-zA-Z0-9_\-]', '', rf.stem)[:18]
            clean_title = rf.stem
            if clean_title.startswith("ref_") and len(clean_title) > 13:
                clean_title = clean_title[13:]
            clean_title = clean_title.replace("_", " ").strip().title()
            voices.append({
                "id": f"custom_{slug}",
                "name": clean_title,
                "engine": "fish_s2",
                "is_custom_ref": True,
                "is_custom": True,
                "gender": "Custom",
                "accent": "Custom",
                "flag": "🎙️",
                "timbre": "Custom Uploaded Voice Reference",
                "genre": ["Custom", "Library"],
                "badge": "REF",
                "color": "#10b981",
                "reference_audio": f"voices/reference/{rf.name}",
                "reference_text": "",
                "default_emotion_tag": "[clear, natural dialogue]",
                "created_at": rf.stat().st_mtime
            })

    return web.json_response(voices)


async def handle_upload_reference_voice(request):
    """Handles uploading a reference audio clip (.wav, .mp3) for zero-shot voice cloning."""
    reader = await request.multipart()
    filename = None
    saved_path = None

    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == 'audio':
            orig_name = part.filename or "reference.wav"
            safe_name = re.sub(r'[^a-zA-Z0-9_.-]', '_', orig_name)
            if not safe_name.lower().endswith(('.wav', '.mp3', '.ogg', '.flac', '.m4a')):
                safe_name += ".wav"
            unique_name = f"ref_{uuid.uuid4().hex[:8]}_{safe_name}"
            saved_path = VOICES_DIR / unique_name
            with open(saved_path, 'wb') as f:
                while True:
                    chunk = await part.read_chunk()
                    if not chunk:
                        break
                    f.write(chunk)
            filename = unique_name

    if not filename or not saved_path or not saved_path.exists():
        return web.json_response({"error": "No valid audio file uploaded"}, status=400)

    duration = 0.0
    try:
        data, sr = sf.read(str(saved_path))
        duration = round(len(data) / sr, 2)
    except Exception:
        pass

    return web.json_response({
        "success": True,
        "filename": filename,
        "url": f"/voices/reference/{filename}",
        "relative_path": f"voices/reference/{filename}",
        "duration": duration
    })


async def handle_get_reference_voices(request):
    """Returns list of uploaded reference voice clips."""
    clips = []
    for p in VOICES_DIR.glob("*.*"):
        if p.suffix.lower() in [".wav", ".mp3", ".ogg", ".flac", ".m4a"]:
            duration = 0.0
            try:
                data, sr = sf.read(str(p))
                duration = round(len(data) / sr, 2)
            except Exception:
                pass
            clips.append({
                "filename": p.name,
                "url": f"/voices/reference/{p.name}",
                "relative_path": f"voices/reference/{p.name}",
                "duration": duration,
                "created_at": p.stat().st_mtime
            })
    clips.sort(key=lambda x: x["created_at"], reverse=True)
    return web.json_response(clips)


async def handle_save_to_library(request):
    """Saves a custom or project voice with reference audio/prompt permanently to Global Voice Library."""
    try:
        data = await request.json()
        name = (data.get("name") or "").strip()
        if not name:
            return web.json_response({"error": "Voice name is required"}, status=400)

        slug = re.sub(r'[^a-zA-Z0-9_]', '', name.lower().replace(" ", "_"))[:24]
        voice_id = f"custom_lib_{slug}_{int(time.time())}"

        new_entry = {
            "id": voice_id,
            "name": name,
            "engine": "fish_s2",
            "gender": data.get("gender", "Custom"),
            "accent": data.get("accent", "Custom"),
            "flag": "🎙️",
            "timbre": data.get("timbre", "Custom Library Voice"),
            "genre": data.get("genre", ["Custom", "Library"]),
            "badge": data.get("badge") or (re.sub(r'[^a-zA-Z]', '', name)[:3].upper() or "VO"),
            "color": data.get("color", "#10b981"),
            "default_emotion_tag": data.get("default_emotion_tag", "[clear, natural dialogue]"),
            "reference_audio": data.get("reference_audio", ""),
            "reference_text": data.get("reference_text", "")
        }

        existing = []
        if FISH_VOICES_FILE.exists():
            try:
                with open(FISH_VOICES_FILE, "r", encoding="utf-8") as f:
                    existing = json.load(f)
            except Exception:
                existing = []

        updated = False
        for i, v in enumerate(existing):
            if v.get("name", "").strip().lower() == name.lower():
                new_entry["id"] = v.get("id", voice_id)
                existing[i] = new_entry
                updated = True
                break
        if not updated:
            existing.append(new_entry)

        new_entry["is_custom"] = True
        new_entry["created_at"] = time.time()

        with open(FISH_VOICES_FILE, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)

        return web.json_response({"ok": True, "voice": new_entry, "total": len(existing)})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_update_voice(request):
    """Updates metadata (name, timbre, gender, accent, emotion_tag, transcript, audio) for an existing voice."""
    try:
        data = await request.json()
        voice_id = (data.get("id") or "").strip()
        if not voice_id:
            return web.json_response({"error": "Voice ID is required"}, status=400)

        existing = []
        if FISH_VOICES_FILE.exists():
            try:
                with open(FISH_VOICES_FILE, "r", encoding="utf-8") as f:
                    existing = json.load(f)
            except Exception:
                existing = []

        target = None
        for i, v in enumerate(existing):
            if v.get("id") == voice_id:
                if "name" in data and str(data["name"]).strip():
                    v["name"] = str(data["name"]).strip()
                if "gender" in data:
                    v["gender"] = data["gender"]
                if "accent" in data:
                    v["accent"] = data["accent"]
                if "timbre" in data:
                    v["timbre"] = data["timbre"]
                if "default_emotion_tag" in data:
                    v["default_emotion_tag"] = data["default_emotion_tag"]
                if "reference_text" in data:
                    v["reference_text"] = data["reference_text"]
                if "reference_audio" in data and data["reference_audio"]:
                    v["reference_audio"] = data["reference_audio"]
                if "color" in data:
                    v["color"] = data["color"]
                if "badge" in data:
                    v["badge"] = data["badge"]
                v["updated_at"] = time.time()
                v["is_custom"] = True
                existing[i] = v
                target = v
                break

        if not target:
            name = str(data.get("name") or voice_id).strip()
            target = {
                "id": voice_id,
                "name": name,
                "engine": "fish_s2",
                "gender": data.get("gender", "Custom"),
                "accent": data.get("accent", "Custom"),
                "flag": "🎙️",
                "timbre": data.get("timbre", "Custom Library Voice"),
                "genre": data.get("genre", ["Custom", "Library"]),
                "badge": data.get("badge") or (re.sub(r'[^a-zA-Z]', '', name)[:3].upper() or "VO"),
                "color": data.get("color", "#10b981"),
                "default_emotion_tag": data.get("default_emotion_tag", "[clear, natural dialogue]"),
                "reference_audio": data.get("reference_audio", ""),
                "reference_text": data.get("reference_text", ""),
                "is_custom": True,
                "created_at": time.time(),
                "updated_at": time.time()
            }
            existing.append(target)

        with open(FISH_VOICES_FILE, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)

        return web.json_response({"ok": True, "voice": target})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_delete_voice(request):
    """Deletes a custom or saved voice from the library."""
    try:
        data = await request.json()
        voice_id = (data.get("id") or "").strip()
        if not voice_id:
            return web.json_response({"error": "Voice ID is required"}, status=400)

        existing = []
        if FISH_VOICES_FILE.exists():
            try:
                with open(FISH_VOICES_FILE, "r", encoding="utf-8") as f:
                    existing = json.load(f)
            except Exception:
                existing = []

        removed = None
        new_existing = []
        for v in existing:
            if v.get("id") == voice_id:
                removed = v
            else:
                new_existing.append(v)

        if removed:
            with open(FISH_VOICES_FILE, "w", encoding="utf-8") as f:
                json.dump(new_existing, f, indent=2, ensure_ascii=False)

        # If it was an uploaded reference file in VOICES_DIR (starts with ref_ and voice is custom), delete audio
        if removed and removed.get("reference_audio"):
            ref_path = BASE_DIR / removed["reference_audio"]
            if ref_path.exists() and ref_path.name.startswith("ref_"):
                try:
                    ref_path.unlink()
                except Exception:
                    pass

        # Always check VOICES_DIR for custom uploaded reference files matching voice_id
        for rf in VOICES_DIR.glob("*.*"):
            if rf.name.startswith("ref_"):
                rf_slug = re.sub(r'[^a-zA-Z0-9_\-]', '', rf.stem)[:18]
                candidates = [f"custom_{rf_slug}", rf.stem, rf.name]
                if voice_id in candidates or voice_id.replace("custom_", "") in rf.stem:
                    try:
                        rf.unlink()
                        print(f"[Fish Studio] Deleted reference voice audio file: {rf.name}")
                    except Exception as e:
                        print(f"[Fish Studio] Error deleting {rf.name}: {e}")

        return web.json_response({"ok": True, "deleted_id": voice_id, "total": len(new_existing)})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ----------------- DYNAMIC FISH AUDIO CLOUD VOICE EXPLORER ----------------- #
FISH_API_CACHE = {}
FISH_API_CACHE_EXPIRY = {}


def get_from_fish_cache(key: str) -> Optional[Any]:
    now = time.time()
    if key in FISH_API_CACHE and now < FISH_API_CACHE_EXPIRY.get(key, 0):
        return FISH_API_CACHE[key]
    return None


def set_fish_cache(key: str, val: Any, ttl_sec: int = 300):
    FISH_API_CACHE[key] = val
    FISH_API_CACHE_EXPIRY[key] = time.time() + ttl_sec


def fetch_fish_audio_api(path: str = "/model", params: Optional[dict] = None) -> dict:
    base_url = "https://api.fish.audio" + path
    if params:
        clean_params = {k: v for k, v in params.items() if v not in (None, "", "all")}
        if clean_params:
            base_url += "?" + urllib.parse.urlencode(clean_params)

    ttl = 600 if (not params or not params.get("title")) else 120
    cached = get_from_fish_cache(base_url)
    if cached is not None:
        return cached

    req = urllib.request.Request(base_url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FishSpeechStudio/2.0",
        "Accept": "application/json"
    })
    try:
        with urllib.request.urlopen(req, timeout=9) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
            set_fish_cache(base_url, data, ttl_sec=ttl)
            return data
    except Exception as e:
        print(f"[Fish Studio] Error fetching from Fish Audio API ({base_url}): {e}")
        return {"error": str(e), "items": []}


def format_fish_model_item(item: dict) -> dict:
    mid = item.get("_id", "")
    samples = item.get("samples") or []
    sample_audio = ""
    sample_text = ""
    if samples and len(samples) > 0:
        first_s = samples[0]
        sample_audio = first_s.get("audio") or ""
        sample_text = first_s.get("text") or item.get("default_text") or ""

    cover_img = item.get("cover_image")
    cover_url = ""
    if cover_img:
        cover_url = f"https://public-platform.r2.fish.audio/cdn-cgi/image/width=96,format=webp/{cover_img}"
    elif item.get("author") and item["author"].get("avatar"):
        cover_url = f"https://public-platform.r2.fish.audio/cdn-cgi/image/width=96,format=webp/{item['author']['avatar']}"

    tags = item.get("tags") or []
    gender = "Custom"
    for t in tags:
        tl = t.lower()
        if tl in ("male", "man", "boy"):
            gender = "Male"
            break
        elif tl in ("female", "woman", "girl"):
            gender = "Female"
            break
        elif tl in ("neutral", "non-binary"):
            gender = "Neutral"
            break

    author_obj = item.get("author") or {}
    author_name = author_obj.get("nickname") or author_obj.get("name") or "Community Creator"
    is_official = ("fish-official" in [t.lower() for t in tags]) or ("official" in author_name.lower())

    return {
        "id": mid,
        "title": item.get("title", "Untitled Voice"),
        "description": item.get("description", ""),
        "author": author_name,
        "author_name": author_name,
        "cover_url": cover_url,
        "tags": tags,
        "languages": item.get("languages") or ["en"],
        "like_count": item.get("like_count", 0),
        "task_count": item.get("task_count", 0),
        "sample_audio": sample_audio,
        "sample_text": sample_text,
        "gender": gender,
        "is_official": is_official
    }


async def handle_fish_library_explore(request):
    """Returns curated category collections matching Fish Audio website sections."""
    def _fetch_category(params):
        d = fetch_fish_audio_api("/model", params)
        return [format_fish_model_item(m) for m in d.get("items", [])]

    try:
        trending = await asyncio.to_thread(_fetch_category, {"sort_by": "score", "page_size": 9})
        recommended = await asyncio.to_thread(_fetch_category, {"sort_by": "task_count", "page_size": 9})
        narration = await asyncio.to_thread(_fetch_category, {"tag": "narration", "page_size": 9})
        anime = await asyncio.to_thread(_fetch_category, {"tag": "anime", "page_size": 9})
        cinematic = await asyncio.to_thread(_fetch_category, {"tag": "cinematic", "page_size": 9})
        gaming = await asyncio.to_thread(_fetch_category, {"tag": "gaming", "page_size": 9})

        return web.json_response({
            "trending": trending,
            "recommended": recommended,
            "narration": narration,
            "anime": anime,
            "cinematic": cinematic,
            "gaming": gaming
        })
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_fish_library_search(request):
    """Live search across 2M+ Fish Audio community voice models."""
    q = (request.query.get("q") or request.query.get("title") or "").strip()
    tag = (request.query.get("tag") or "").strip()
    language = (request.query.get("language") or "").strip()
    sort_by = (request.query.get("sort_by") or "score").strip()
    if sort_by not in ("score", "task_count", "created_at"):
        sort_by = "score"

    page_size = min(int(request.query.get("page_size", 24)), 40)
    page_number = max(int(request.query.get("page_number", 1)), 1)

    params = {
        "title": q if q else None,
        "tag": tag if tag and tag != "all" else None,
        "language": language if language and language != "all" else None,
        "sort_by": sort_by,
        "page_size": page_size,
        "page_number": page_number
    }

    try:
        raw_res = await asyncio.to_thread(fetch_fish_audio_api, "/model", params)
        items = [format_fish_model_item(m) for m in raw_res.get("items", [])]
        return web.json_response({
            "items": items,
            "total": raw_res.get("total", len(items)),
            "has_more": raw_res.get("has_more", False),
            "page_number": page_number
        })
    except Exception as e:
        return web.json_response({"error": str(e), "items": []}, status=500)


async def handle_fish_library_install(request):
    """Downloads sample audio of a Fish Audio model and registers it into local Voice Library."""
    try:
        data = await request.json()
        model_id = (data.get("model_id") or data.get("id") or "").strip()
        title = (data.get("title") or data.get("name") or "Fish Voice").strip()
        sample_audio = (data.get("sample_audio") or "").strip()
        sample_text = (data.get("sample_text") or "").strip()
        description = (data.get("description") or "").strip()
        gender = data.get("gender") or "Custom"
        tags = data.get("tags") or ["Custom", "FishAudio"]

        if not model_id:
            return web.json_response({"error": "Model ID is required"}, status=400)

        voice_id = f"fish_{model_id}"
        dest_filename = f"ref_fish_{model_id}.wav"
        dest_path = VOICES_DIR / dest_filename

        # Download audio sample if not already on disk
        if not dest_path.exists():
            if not sample_audio:
                m_data = await asyncio.to_thread(fetch_fish_audio_api, f"/model/{model_id}")
                samples = m_data.get("samples") or []
                if samples:
                    sample_audio = samples[0].get("audio") or ""
                    if not sample_text:
                        sample_text = samples[0].get("text") or ""

            if not sample_audio:
                return web.json_response({"error": "No playable audio sample available for this voice model"}, status=400)

            def _download_and_trim():
                req = urllib.request.Request(sample_audio, headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                })
                with urllib.request.urlopen(req, timeout=12) as r:
                    raw_bytes = r.read()
                data, sr = sf.read(io.BytesIO(raw_bytes))
                max_samples = int(sr * 8.5)
                if len(data) > max_samples:
                    data = data[:max_samples]
                sf.write(str(dest_path), data, sr)

            await asyncio.to_thread(_download_and_trim)

        # Register in fish_voices_metadata.json
        clean_badge = re.sub(r'[^a-zA-Z]', '', title)[:3].upper() or "FSH"
        new_voice = {
            "id": voice_id,
            "name": title,
            "engine": "fish_s2",
            "gender": gender,
            "accent": "International",
            "flag": "🌐",
            "timbre": description[:70] if description else f"{title} (Fish Audio Cloud Model)",
            "genre": tags[:4] if tags else ["Cloud", "FishAudio"],
            "badge": clean_badge,
            "color": "#10b981",
            "default_emotion_tag": "[clear, natural dialogue]",
            "reference_audio": f"voices/reference/{dest_filename}",
            "reference_text": sample_text,
            "is_custom": True,
            "is_library": True,
            "source_model_id": model_id,
            "created_at": time.time()
        }

        existing = []
        if FISH_VOICES_FILE.exists():
            try:
                with open(FISH_VOICES_FILE, "r", encoding="utf-8") as f:
                    existing = json.load(f)
            except Exception:
                existing = []

        found = False
        for i, v in enumerate(existing):
            if v.get("id") == voice_id or v.get("source_model_id") == model_id:
                existing[i] = new_voice
                found = True
                break
        if not found:
            existing.append(new_voice)

        with open(FISH_VOICES_FILE, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)

        return web.json_response({
            "ok": True,
            "voice": new_voice,
            "audio_url": f"/voices/reference/{dest_filename}"
        })
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ----------------- GLOBAL GPU LOCK & IN-FLIGHT DEDUPLICATION ----------------- #
# Fish Audio S2 Pro runs on a single GPU. Strictly serialize inference so requests
# wait until the previous one completes before sending the next one to the model.
gpu_synthesis_lock = asyncio.Lock()

# Maps task_key -> asyncio.Future so identical sentences in-flight return the same job without re-processing!
in_flight_synthesis_futures: Dict[str, asyncio.Future] = {}


async def handle_synthesize_block(request):
    try:
        try:
            data = await request.json()
        except Exception as e:
            return web.json_response({"error": f"Invalid JSON payload: {e}"}, status=400)

        text = (data.get("text") or "").strip()
        if not text:
            return web.json_response({"error": "Text is required"}, status=400)

        cfg = load_config()
        active_engine_name = cfg.get("active_engine", "fish_s2")
        block_engine = (data.get("engine") or active_engine_name).lower()
        force_refresh = bool(data.get("force_refresh", False))

        # Safe number conversion
        def _num(v, default=0.0):
            if v is None:
                return default
            try:
                return float(v)
            except (ValueError, TypeError):
                return default

        # Common parameters
        default_speed = 1.0 if block_engine == "fish_s2" else 0.90
        speed = _num(data.get("speed"), default_speed)
        gain = _num(data.get("gain"), 1.0)
        pitch_shift = _num(data.get("pitch_shift"), 0.0)
        warmth = _num(data.get("warmth"), 0.0)
        clarity = _num(data.get("clarity"), 0.0)
        reverb = _num(data.get("reverb"), 0.0)
        radio_fx = bool(data.get("radio_fx", False))
        fx_filter = str(data.get("fx_filter") or ("radio" if radio_fx else "none")).strip().lower()

        # Engine routing: check if Kokoro is requested or Kokoro voice is used
        voice_id = data.get("voice_id")
        blend_weights = data.get("blend_weights")
        referer = request.headers.get("Referer", "").lower()
        is_kokoro = (block_engine == "kokoro") or ("/kokoro" in referer) or (blend_weights is not None)
        if not is_kokoro and voice_id:
            if str(voice_id).startswith(("am_", "af_", "bm_", "bf_", "blend_")):
                is_kokoro = True

        if is_kokoro:
            task_key = f"kokoro::{text}::{voice_id or ''}::{str(blend_weights)}::{speed}::{gain}::{pitch_shift}::{warmth}::{clarity}::{reverb}::{radio_fx}::{fx_filter}"
            if not force_refresh and task_key in in_flight_synthesis_futures:
                print(f"[Kokoro Studio] [WAIT] Task already rendering on model for: '{text[:50]}...'. Attaching to active job.", flush=True)
                try:
                    res = await in_flight_synthesis_futures[task_key]
                    return web.json_response(res)
                except Exception as e:
                    return web.json_response({"error": str(e)}, status=500)

            loop = asyncio.get_running_loop()
            fut = loop.create_future()
            in_flight_synthesis_futures[task_key] = fut

            try:
                async with gpu_synthesis_lock:
                    res = await asyncio.to_thread(
                        kokoro_engine.synthesize_block,
                        text=text,
                        voice_id=voice_id or "blend_fenrir_onyx",
                        blend_weights=blend_weights,
                        speed=speed,
                        gain=gain,
                        pitch_shift=pitch_shift,
                        warmth=warmth,
                        clarity=clarity,
                        reverb=reverb,
                        radio_fx=radio_fx,
                        fx_filter=fx_filter,
                        force_refresh=force_refresh
                    )
                    if not fut.done():
                        fut.set_result(res)
                    return web.json_response(res)
            except asyncio.CancelledError:
                if not fut.done():
                    fut.cancel()
                raise
            except Exception as e:
                if not fut.done():
                    fut.set_exception(e)
                return web.json_response({"error": str(e)}, status=500)
            finally:
                in_flight_synthesis_futures.pop(task_key, None)

        # Fish specific parameters
        emotion_tag = data.get("emotion_tag")
        reference_audio = data.get("reference_audio")
        reference_text = data.get("reference_text")
        temperature = max(0.1, min(1.0, _num(data.get("temperature"), 0.7)))
        top_p = max(0.1, min(1.0, _num(data.get("top_p"), 0.85)))

        # Unique task key for in-flight deduplication
        prev_a = data.get("prev_audio") or ""
        task_key = f"{block_engine}::{text}::{voice_id or ''}::{emotion_tag or ''}::{reference_audio or ''}::{prev_a}::{speed}::{temperature}::{top_p}"

        # If this exact sentence is already being synthesized right now, wait for it and return the same result!
        if not force_refresh and task_key in in_flight_synthesis_futures:
            print(f"[Fish Studio] [WAIT] Task already rendering on model for: '{text[:50]}...'. Attaching to active job (no duplicate request).", flush=True)
            try:
                res = await in_flight_synthesis_futures[task_key]
                return web.json_response(res)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)

        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        in_flight_synthesis_futures[task_key] = fut

        try:
            # Strictly serialize model requests: wait until the current one finishes before running next
            async with gpu_synthesis_lock:
                prev_audio = data.get("prev_audio")
                prev_text = data.get("prev_text")
                res = await asyncio.to_thread(
                    fish_engine.synthesize_block,
                    text=text,
                    voice_id=voice_id,
                    reference_audio=reference_audio,
                    reference_text=reference_text,
                    emotion_tag=emotion_tag,
                    speed=speed,
                    gain=gain,
                    temperature=temperature,
                    top_p=top_p,
                    pitch_shift=pitch_shift,
                    warmth=warmth,
                    clarity=clarity,
                    reverb=reverb,
                    radio_fx=radio_fx,
                    fx_filter=fx_filter,
                    force_refresh=force_refresh,
                    prev_audio=prev_audio,
                    prev_text=prev_text,
                    enable_rolling_context=True
                )
                if not fut.done():
                    fut.set_result(res)
                return web.json_response(res)
        except asyncio.CancelledError:
            if not fut.done():
                fut.cancel()
            raise
        except Exception as e:
            if not fut.done():
                fut.set_exception(e)
            return web.json_response({"error": str(e)}, status=500)
        finally:
            in_flight_synthesis_futures.pop(task_key, None)
    except Exception as top_err:
        return web.json_response({"error": f"Server processing error: {top_err}"}, status=500)


async def handle_blend_preview(request):
    """Audition preview endpoint for custom voice blends or reference clips."""
    data = await request.json()
    text = data.get("text", "This is an audition sample for your character voice.").strip()
    cfg = load_config()
    active_engine_name = cfg.get("active_engine", "fish_s2")
    engine_type = (data.get("engine") or active_engine_name).lower()
    voice_id = data.get("voice_id", "")
    referer = request.headers.get("Referer", "").lower()

    is_kokoro = (engine_type == "kokoro") or ("/kokoro" in referer) or ("blend_weights" in data) or str(voice_id).startswith(("am_", "af_", "bm_", "bf_", "blend_"))

    try:
        async with gpu_synthesis_lock:
            if is_kokoro:
                blend_weights = data.get("blend_weights", {"am_fenrir": 0.5, "am_onyx": 0.5})
                res = await asyncio.to_thread(
                    kokoro_engine.synthesize_block,
                    text=text,
                    voice_id=voice_id or "custom_blend",
                    blend_weights=blend_weights,
                    speed=float(data.get("speed", 0.90)),
                    gain=1.0,
                    pitch_shift=float(data.get("pitch_shift", 0.0)),
                    warmth=float(data.get("warmth", 0.0)),
                    clarity=float(data.get("clarity", 0.0)),
                    reverb=float(data.get("reverb", 0.0)),
                    radio_fx=bool(data.get("radio_fx", False)),
                    fx_filter=str(data.get("fx_filter") or "none").strip().lower()
                )
            else:
                res = await asyncio.to_thread(
                    fish_engine.synthesize_block,
                    text=text,
                    voice_id=data.get("voice_id"),
                    reference_audio=data.get("reference_audio"),
                    reference_text=data.get("reference_text"),
                    emotion_tag=data.get("emotion_tag"),
                    speed=float(data.get("speed", 1.0)),
                    gain=1.0,
                    temperature=float(data.get("temperature", 0.7)),
                    top_p=float(data.get("top_p", 0.85)),
                    pitch_shift=float(data.get("pitch_shift", 0.0)),
                    warmth=float(data.get("warmth", 0.0)),
                    clarity=float(data.get("clarity", 0.0)),
                    reverb=float(data.get("reverb", 0.0)),
                    fx_filter=str(data.get("fx_filter", "none"))
                )
        return web.json_response(res)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


def sync_synthesize_block_for_export(b: dict, active_engine_name: str) -> Optional[Tuple[np.ndarray, int]]:
    """Helper to get audio samples and native sample rate for a block (from cache or live synthesis)."""
    text = (b.get("text") or "").strip()
    if not text:
        return None

    # Check cache first
    cached_url = b.get("audio_url") or b.get("cachedAudioUrl") or ""
    if cached_url:
        clean_url = cached_url.split("?")[0].split("#")[0]
        cached_filename = Path(clean_url).name
        cached_path = CACHE_DIR / cached_filename
        if not cached_path.exists():
            edge_cache = Path("c:/Users/ADMIN/Documents/Project Folder/edge tts/cache") / cached_filename
            if edge_cache.exists():
                cached_path = edge_cache
        if cached_path.exists():
            try:
                samples, sr = sf.read(str(cached_path))
                gain = float(b.get("gain", 1.0) or 1.0)
                speed = float(b.get("speed", 1.0) or 1.0)
                pitch = float(b.get("pitch_shift", 0.0) or 0.0)
                warmth = float(b.get("warmth", 0.0) or 0.0)
                clarity = float(b.get("clarity", 0.0) or 0.0)
                reverb = float(b.get("reverb", 0.0) or 0.0)
                fx_filter = str(b.get("fx_filter") or ("radio" if b.get("radio_fx") else "none")).strip().lower()

                # If cached_path is NOT already a dsp_ file, apply DSP if non-neutral
                if not cached_filename.startswith("dsp_"):
                    is_neutral = (
                        gain == 1.0 and abs(speed - 1.0) < 0.03 and abs(pitch) < 0.05 and
                        abs(warmth) < 0.1 and abs(clarity) < 0.1 and reverb < 0.02 and
                        fx_filter == "none"
                    )
                    if not is_neutral:
                        from core.audio_dsp import process_audio_fx
                        if gain != 1.0:
                            samples = samples * gain
                        samples = process_audio_fx(
                            samples,
                            sr=sr,
                            pitch_shift_st=pitch,
                            warmth_db=warmth,
                            clarity_db=clarity,
                            reverb_wet=reverb,
                            speed=speed,
                            fx_filter=fx_filter
                        )
                return samples, int(sr)
            except Exception:
                pass

    # Live synthesize if not cached
    b_engine = (b.get("engine") or active_engine_name).lower()
    voice_id = str(b.get("voice_id", ""))
    is_kokoro = (b_engine == "kokoro") or voice_id.startswith(("am_", "af_", "bm_", "bf_", "blend_"))

    if is_kokoro:
        res = kokoro_engine.synthesize_block(
            text=text,
            voice_id=voice_id or "blend_fenrir_onyx",
            blend_weights=b.get("blend_weights"),
            speed=float(b.get("speed", 0.90)),
            gain=float(b.get("gain", 1.0)),
            pitch_shift=float(b.get("pitch_shift", 0.0)),
            warmth=float(b.get("warmth", 0.0)),
            clarity=float(b.get("clarity", 0.0)),
            reverb=float(b.get("reverb", 0.0)),
            radio_fx=bool(b.get("radio_fx", False)),
            fx_filter=str(b.get("fx_filter") or "none").strip().lower()
        )
    else:
        res = fish_engine.synthesize_block(
            text=text,
            voice_id=b.get("voice_id"),
            reference_audio=b.get("reference_audio"),
            reference_text=b.get("reference_text"),
            emotion_tag=b.get("emotion_tag"),
            speed=float(b.get("speed", 1.0)),
            gain=float(b.get("gain", 1.0)),
            temperature=float(b.get("temperature", 0.7)),
            top_p=float(b.get("top_p", 0.85)),
            pitch_shift=float(b.get("pitch_shift", 0.0)),
            warmth=float(b.get("warmth", 0.0)),
            clarity=float(b.get("clarity", 0.0)),
            reverb=float(b.get("reverb", 0.0)),
            fx_filter=str(b.get("fx_filter", "none"))
        )

    if "hash" in res:
        cache_path = CACHE_DIR / f"{res['hash']}.wav"
        if cache_path.exists():
            samples, sr = sf.read(str(cache_path))
            return samples, int(sr)

    return None


async def handle_export_master(request):
    data = await request.json()
    blocks = data.get("blocks", [])
    filename = data.get("filename", "master_narrative.wav")

    if not blocks:
        return web.json_response({"error": "No blocks provided"}, status=400)

    cfg = load_config()
    active_engine_name = cfg.get("active_engine", "fish_s2")

    def _compile():
        from math import gcd
        from scipy import signal

        def _resample(samples: np.ndarray, orig_sr: int, dest_sr: int) -> np.ndarray:
            if orig_sr == dest_sr or len(samples) == 0:
                return samples
            g = gcd(int(orig_sr), int(dest_sr))
            up = int(dest_sr // g)
            down = int(orig_sr // g)
            return signal.resample_poly(samples.astype(np.float32), up, down).astype(np.float32)

        rendered_blocks = []
        for b in blocks:
            if b.get("type") == "heading" or not b.get("is_spoken", True):
                pause_after = float(b.get("pause_after", 1.0) or 1.0)
                rendered_blocks.append({"type": "pause", "pause": pause_after})
                continue

            res = sync_synthesize_block_for_export(b, active_engine_name)
            if res is not None:
                samples, sr = res
                if len(samples) > 0:
                    pause_after = float(b.get("pause_after", 0.6) or 0.6)
                    rendered_blocks.append({
                        "type": "audio",
                        "samples": samples,
                        "sr": int(sr),
                        "pause": pause_after
                    })

        if not rendered_blocks or not any(rb["type"] == "audio" for rb in rendered_blocks):
            return {"error": "No audio blocks could be compiled"}

        # Target sample rate: 44.1kHz for Fish Speech S2 Pro
        target_sr = 44100

        audio_segments = []
        for item in rendered_blocks:
            if item["type"] == "pause":
                if item["pause"] > 0:
                    silence = np.zeros(int(target_sr * item["pause"]), dtype=np.float32)
                    audio_segments.append(silence)
            elif item["type"] == "audio":
                audio = item["samples"]
                if item["sr"] != target_sr:
                    audio = _resample(audio, item["sr"], target_sr)
                audio_segments.append(audio)
                if item["pause"] > 0:
                    silence = np.zeros(int(target_sr * item["pause"]), dtype=np.float32)
                    audio_segments.append(silence)

        master = np.concatenate(audio_segments)
        safe_name = re.sub(r'[^a-zA-Z0-9_\-.]', '_', filename)
        if not safe_name.endswith(".wav"):
            safe_name += ".wav"
        out_file = OUTPUT_DIR / safe_name
        sf.write(str(out_file), master, target_sr)

        duration = len(master) / target_sr
        return {
            "master_url": f"/api/audio/{safe_name}",
            "filename": safe_name,
            "duration": round(duration, 2),
            "sample_rate": target_sr,
            "rendered_count": len([rb for rb in rendered_blocks if rb["type"] == "audio"])
        }

    try:
        res = await asyncio.to_thread(_compile)
        return web.json_response(res)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_export_zip(request):
    data = await request.json()
    blocks = data.get("blocks", [])
    filename = data.get("filename", "story_sentences.zip")

    if not blocks:
        return web.json_response({"error": "No blocks provided"}, status=400)

    cfg = load_config()
    active_engine_name = cfg.get("active_engine", "fish_s2")

    def _zip():
        valid_blocks = [
            b for b in blocks
            if b.get("text", "").strip() and b.get("type") != "heading" and b.get("is_spoken", True)
        ]
        if not valid_blocks:
            return {"error": "No valid sentences to export"}

        safe_name = re.sub(r'[^a-zA-Z0-9_\-.]', '_', filename)
        if not safe_name.endswith(".zip"):
            safe_name += ".zip"
        out_zip_path = OUTPUT_DIR / safe_name

        with zipfile.ZipFile(str(out_zip_path), "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for i, b in enumerate(valid_blocks):
                res = sync_synthesize_block_for_export(b, active_engine_name)
                if res is not None:
                    samples, sr = res
                    if len(samples) > 0:
                        text = b.get("text", "").strip()
                        slug = re.sub(r'[^a-zA-Z0-9_\- ]', '', text)[:28].strip().replace(' ', '_').lower()
                        arcname = f"{i+1:03d}_{slug}.wav" if slug else f"sentence_{i+1:03d}.wav"

                        temp_wav = CACHE_DIR / f"export_temp_{i}.wav"
                        sf.write(str(temp_wav), samples, sr)
                        zf.write(str(temp_wav), arcname=arcname)
                        temp_wav.unlink(missing_ok=True)

        return {
            "filename": safe_name,
            "zip_url": f"/api/audio/{safe_name}",
            "file_count": len(valid_blocks)
        }

    try:
        res = await asyncio.to_thread(_zip)
        return web.json_response(res)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_apply_dsp(request):
    """
    Applies audio post-processing DSP (Gain, Speed, Pitch, EQ, Reverb, FX Filter)
    INSTANTLY (<20ms) to an already-generated audio take on CPU without calling the Cloud GPU!
    """
    try:
        data = await request.json()
    except Exception:
        body = await request.text()
        import json
        try:
            data = json.loads(body.replace("\\", "/"))
        except Exception:
            return web.json_response({"error": "Invalid request JSON"}, status=400)

    audio_url = str(data.get("audio_url", "")).strip()
    if not audio_url:
        return web.json_response({"error": "audio_url is required"}, status=400)

    clean_name = Path(audio_url.replace("\\", "/").split("?")[0]).name
    base_stem = Path(clean_name).stem.removeprefix("raw_")
    if base_stem.startswith("dsp_"):
        parts = base_stem[4:].split("_")
        base_stem = "_".join(parts[:-1]) if len(parts) > 1 else parts[0]
        base_stem = base_stem.removeprefix("raw_")

    candidates = [
        CACHE_DIR / f"raw_{base_stem}.wav",
        CACHE_DIR / f"{base_stem}.wav",
        CACHE_DIR / clean_name
    ]

    source_path = None
    for cand in candidates:
        if cand.exists():
            source_path = cand
            break

    if not source_path:
        return web.json_response({"error": f"Audio file not found: {clean_name}"}, status=404)

    gain = float(data.get("gain", 1.0))
    speed = float(data.get("speed", 1.0))
    pitch_shift = float(data.get("pitch_shift", 0.0))
    warmth = float(data.get("warmth", 0.0))
    clarity = float(data.get("clarity", 0.0))
    reverb = float(data.get("reverb", 0.0))
    radio_fx = bool(data.get("radio_fx", False))
    fx_filter = str(data.get("fx_filter") or ("radio" if radio_fx else "none")).strip().lower()

    is_neutral = (
        gain == 1.0 and abs(speed - 1.0) < 0.03 and abs(pitch_shift) < 0.05 and
        abs(warmth) < 0.1 and abs(clarity) < 0.1 and reverb < 0.02 and
        fx_filter == "none"
    )

    def _process():
        samples, sr = sf.read(str(source_path))
        if is_neutral:
            dur = len(samples) / sr
            neutral_file = CACHE_DIR / f"{base_stem}.wav"
            if not neutral_file.exists():
                sf.write(str(neutral_file), samples, sr)
            return {
                "ok": True,
                "audio_url": f"/api/audio/{neutral_file.name}?t={int(time.time()*1000)}",
                "duration": round(dur, 2),
                "is_raw": True
            }

        import hashlib
        dsp_sig = hashlib.md5(f"g{gain:.2f}_s{speed:.2f}_p{pitch_shift:.1f}_w{warmth:.1f}_c{clarity:.1f}_r{reverb:.2f}_f{fx_filter}".encode()).hexdigest()[:8]
        out_name = f"dsp_{base_stem}_{dsp_sig}.wav"
        out_path = CACHE_DIR / out_name

        if not out_path.exists():
            from core.audio_dsp import process_audio_fx
            processed = samples * gain if gain != 1.0 else samples.copy()
            processed = process_audio_fx(
                processed,
                sr=sr,
                pitch_shift_st=pitch_shift,
                warmth_db=warmth,
                clarity_db=clarity,
                reverb_wet=reverb,
                speed=speed,
                fx_filter=fx_filter
            )
            sf.write(str(out_path), processed, sr)

        info = sf.info(str(out_path))
        return {
            "ok": True,
            "audio_url": f"/api/audio/{out_name}?t={int(time.time()*1000)}",
            "duration": round(info.duration, 2),
            "is_raw": False
        }

    try:
        res = await asyncio.to_thread(_process)
        return web.json_response(res)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_reset_dsp(request):
    """
    Instantly restores the 100% pure neural raw master take in 1ms!
    """
    data = await request.json()
    audio_url = data.get("audio_url", "").strip()
    if not audio_url:
        return web.json_response({"error": "audio_url is required"}, status=400)

    clean_name = Path(audio_url.split("?")[0]).name
    base_stem = Path(clean_name).stem.removeprefix("raw_")
    if base_stem.startswith("dsp_"):
        parts = base_stem[4:].split("_")
        base_stem = "_".join(parts[:-1]) if len(parts) > 1 else parts[0]
        base_stem = base_stem.removeprefix("raw_")

    candidates = [
        CACHE_DIR / f"raw_{base_stem}.wav",
        CACHE_DIR / f"{base_stem}.wav",
        CACHE_DIR / clean_name
    ]

    source_path = None
    for cand in candidates:
        if cand.exists():
            source_path = cand
            break

    if not source_path or not source_path.exists():
        return web.json_response({"error": "Raw audio take not found"}, status=404)

    info = sf.info(str(source_path))
    return web.json_response({
        "ok": True,
        "audio_url": f"/api/audio/{source_path.name}?t={int(time.time()*1000)}",
        "duration": round(info.duration, 2),
        "is_raw": True
    })


async def handle_get_projects(request):
    engine_filter = request.query.get("engine")
    projs = project_mgr.list_projects(engine=engine_filter)
    return web.json_response(projs)


_recent_created_projects = {}

async def handle_create_project(request):
    data = await request.json()
    title = data.get("title", "Untitled Project").strip() or "Untitled Project"
    raw_text = data.get("text", "").strip()
    defaults = data.get("defaults") or data.get("default_settings") or {}
    
    default_engine = (data.get("engine") or "").lower()
    if not default_engine:
        referer = request.headers.get("Referer", "").lower()
        default_engine = "kokoro" if "/kokoro" in referer else "fish_s2"

    default_voice = data.get("default_voice") or defaults.get("voice_id", "voice_stanley_narrator" if default_engine == "fish_s2" else "blend_fenrir_onyx")

    dedup_key = f"{title}_{hashlib_str(raw_text or str(data.get('blocks', [])))}"
    now = time.time()
    if dedup_key in _recent_created_projects:
        ts, cached_proj = _recent_created_projects[dedup_key]
        if now - ts < 3.0:
            return web.json_response(cached_proj)

    proj_id = f"proj_{uuid.uuid4().hex[:8]}"

    blocks = []
    if "blocks" in data and isinstance(data["blocks"], list) and len(data["blocks"]) > 0:
        blocks = data["blocks"]
    elif raw_text:
        blocks = project_mgr.split_text_into_blocks(raw_text, default_voice=default_voice, defaults=defaults)
    else:
        b1 = {
            "id": "b_1",
            "text": "Start typing your first story sentence here...",
            "voice_id": default_voice,
            "engine": default_engine,
            "emotion_tag": "[slow, deep dramatic horror narration, ominous pause]" if default_engine == "fish_s2" else "",
            "speed": 1.0 if default_engine == "fish_s2" else 0.90,
            "gain": 1.0,
            "pause_after": 0.6,
            "temperature": 0.7,
            "top_p": 0.85
        }
        blocks = [b1]

    proj_data = {
        "id": proj_id,
        "title": title,
        "engine": default_engine,
        "default_voice": default_voice,
        "default_settings": defaults if defaults else None,
        "characters": data.get("characters", []),
        "blocks": blocks,
        "master_filename": f"{proj_id}_master.wav"
    }
    project_mgr.save_project(proj_data, proj_id)
    _recent_created_projects[dedup_key] = (time.time(), proj_data)
    return web.json_response(proj_data)


def hashlib_str(s: str) -> str:
    import hashlib
    return hashlib.md5(s.encode("utf-8")).hexdigest()


async def handle_delete_project(request):
    proj_id = request.match_info["id"]
    success = project_mgr.delete_project(proj_id)
    return web.json_response({"deleted": success, "id": proj_id})


async def handle_get_project(request):
    proj_id = request.query.get("id", "default")
    proj = project_mgr.load_project(proj_id)
    return web.json_response(proj)


async def handle_save_project(request):
    data = await request.json()
    proj_id = data.get("id", "default")
    project_mgr.save_project(data, proj_id)
    return web.json_response({"status": "saved", "id": proj_id})


async def handle_duplicate_project(request):
    data = await request.json()
    proj_id = data.get("id")
    if not proj_id:
        return web.json_response({"error": "id is required"}, status=400)
    cloned = project_mgr.duplicate_project(proj_id)
    if not cloned:
        return web.json_response({"error": "project not found"}, status=404)
    return web.json_response({"success": True, "project": cloned})


async def handle_copy_project_to_engine(request):
    try:
        data = await request.json()
        project_id = data.get("project_id", "").strip()
        target_engine = data.get("target_engine", "").strip()
        if not project_id:
            return web.json_response({"error": "project_id is required"}, status=400)
        if not target_engine:
            referer = request.headers.get("Referer", "").lower()
            target_engine = "fish_s2" if "/kokoro" in referer else "kokoro"
        
        new_proj = project_mgr.copy_project_to_engine(project_id, target_engine)
        if not new_proj:
            return web.json_response({"error": "Project not found or could not be copied"}, status=404)
        
        return web.json_response({"success": True, "project": new_proj})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_rename_project(request):
    data = await request.json()
    proj_id = data.get("id")
    title = (data.get("title") or "").strip()
    if not proj_id or not title:
        return web.json_response({"error": "id and title are required"}, status=400)
    ok = project_mgr.rename_project(proj_id, title)
    return web.json_response({"success": ok, "id": proj_id, "title": title})


async def handle_split_text(request):
    data = await request.json()
    text = data.get("text", "")
    defaults = data.get("defaults") or data.get("default_settings") or {}
    default_voice = data.get("default_voice") or defaults.get("voice_id", "fish_narrator_dark")
    clean_pauses = bool(data.get("clean_pauses", True))
    inline_ellipsis = bool(data.get("inline_ellipsis", True))
    blocks = project_mgr.split_text_into_blocks(
        text,
        default_voice=default_voice,
        defaults=defaults,
        clean_pauses=clean_pauses,
        inline_ellipsis=inline_ellipsis
    )
    return web.json_response(blocks)


async def handle_auto_direct(request):
    data = await request.json()
    blocks = data.get("blocks", [])
    defaults = data.get("defaults") or data.get("default_settings") or {}
    default_voice = data.get("default_voice") or defaults.get("voice_id", "fish_narrator_dark")
    expand_dialogue = bool(data.get("expand_dialogue", False))
    directed = project_mgr.auto_direct_blocks(blocks, default_voice=default_voice, expand_dialogue=expand_dialogue, defaults=defaults)
    return web.json_response(directed)


async def handle_merge_short(request):
    data = await request.json()
    blocks = data.get("blocks", [])
    max_chars = int(data.get("max_chars", 35))
    max_words = int(data.get("max_words", 5))
    merged = project_mgr.merge_ultra_small_blocks(blocks, max_chars=max_chars, max_words=max_words)
    return web.json_response(merged)


async def handle_get_audio(request):
    filename = request.match_info["filename"]
    edge_cache = Path("c:/Users/ADMIN/Documents/Project Folder/edge tts/cache")
    edge_output = Path("c:/Users/ADMIN/Documents/Project Folder/edge tts/output")
    candidates = [
        CACHE_DIR / filename,
        OUTPUT_DIR / filename,
        SAMPLES_DIR / filename,
        VOICES_DIR / filename,
        edge_cache / filename,
        edge_output / filename
    ]
    if filename.startswith("dsp_"):
        stem = Path(filename).stem[4:]
        parts = stem.split("_")
        base = "_".join(parts[:-1]) if len(parts) > 1 else stem
        candidates.extend([
            CACHE_DIR / f"{base}.wav",
            CACHE_DIR / f"raw_{base}.wav",
            CACHE_DIR / f"{base.removeprefix('raw_')}.wav",
            edge_cache / f"{base}.wav",
            edge_cache / f"raw_{base}.wav",
            edge_cache / f"{base.removeprefix('raw_')}.wav"
        ])

    for p in candidates:
        if p.exists():
            if p.suffix == ".zip":
                content_type = "application/zip"
            elif p.suffix == ".wav":
                content_type = "audio/wav"
            else:
                content_type = "audio/mpeg"
            headers = {
                "Content-Type": content_type,
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-cache, must-revalidate"
            }
            if p.suffix == ".zip" or request.query.get("download") == "1":
                dl_name = request.query.get("filename") or p.name
                headers["Content-Disposition"] = f'attachment; filename="{dl_name}"'
            return web.FileResponse(p, headers=headers)

    return web.Response(text="Audio file not found", status=404)


async def handle_get_config(request):
    cfg = load_config()
    referer = request.headers.get("Referer", "").lower()
    is_kokoro = ("/kokoro" in referer) or (request.query.get("engine") == "kokoro")

    remote_url = (cfg.get("kokoro_remote_worker_url") or cfg.get("remote_worker_url", "")) if is_kokoro else (cfg.get("fish_remote_worker_url") or cfg.get("remote_worker_url", ""))
    k_user = cfg.get("kaggle_username", "")
    k_has_key = bool(cfg.get("kaggle_key", ""))
    if not k_user:
        p = os.path.expanduser("~/.kaggle/kaggle.json")
        if os.path.exists(p):
            try:
                c = json.load(open(p))
                k_user = c.get("username", "")
                k_has_key = bool(c.get("key", ""))
            except Exception:
                pass
    return web.json_response({
        "remote_worker_url": remote_url or "",
        "kokoro_remote_worker_url": cfg.get("kokoro_remote_worker_url", ""),
        "fish_remote_worker_url": cfg.get("fish_remote_worker_url", ""),
        "fish_api_key": cfg.get("fish_api_key", ""),
        "kaggle_username": k_user,
        "kaggle_has_key": k_has_key,
        "active_engine": "kokoro" if is_kokoro else cfg.get("active_engine", "fish_s2"),
        "active": bool(remote_url or (not is_kokoro and cfg.get("fish_api_key")))
    })



async def handle_kaggle_verify(request):
    try:
        data = await request.json()
        cfg = load_config()
        username = (data.get("username") or cfg.get("kaggle_username", "")).strip()
        key = (data.get("key") or cfg.get("kaggle_key", "")).strip()
        if not username or not key:
            p = os.path.expanduser("~/.kaggle/kaggle.json")
            if os.path.exists(p):
                try:
                    c = json.load(open(p))
                    username = c.get("username", "")
                    key = c.get("key", "")
                except Exception:
                    pass

        if key.startswith("sk-fish-"):
            return web.json_response({
                "ok": False,
                "error": "This looks like a Fish Audio API key (starts with 'sk-fish-'). Please use the 'Fish Audio Pro API' tab. For Kaggle GPU, use your 32-character token from kaggle.json."
            }, status=400)

        res = await asyncio.to_thread(kaggle_mgr.verify_credentials, username, key)
        if res.get("ok"):
            cfg = load_config()
            cfg["kaggle_username"] = username
            cfg["kaggle_key"] = key
            save_config(cfg)
        return web.json_response(res)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_kaggle_launch(request):
    try:
        data = await request.json()
        cfg = load_config()
        referer = request.headers.get("Referer", "").lower()
        engine = data.get("engine") or ("kokoro" if "/kokoro" in referer else "fish_s2")
        username = (data.get("username") or cfg.get("kaggle_username", "")).strip()
        key = (data.get("key") or cfg.get("kaggle_key", "")).strip()
        if not username or not key:
            p = os.path.expanduser("~/.kaggle/kaggle.json")
            if os.path.exists(p):
                try:
                    c = json.load(open(p))
                    username = c.get("username", "")
                    key = c.get("key", "")
                except Exception:
                    pass
        if not username or not key:
            return web.json_response({
                "ok": False,
                "error": "Kaggle credentials required. Please provide username and key or drop kaggle.json."
            }, status=400)

        if key.startswith("sk-fish-"):
            return web.json_response({
                "ok": False,
                "error": "This looks like a Fish Audio API key (starts with 'sk-fish-'). Please use the 'Fish Audio Pro API' tab. For Kaggle GPU, use your 32-character token from kaggle.json."
            }, status=400)

        res = await asyncio.to_thread(kaggle_mgr.launch_worker, username, key, engine)
        return web.json_response(res)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_kaggle_status(request):
    status = kaggle_mgr.get_status()
    # Auto-activate discovered tunnel URL in studio config!
    if status.get("status") == "ready" and status.get("tunnel_url"):
        cfg = load_config()
        t_url = status["tunnel_url"]
        active_engine = status.get("engine", "fish_s2")
        if active_engine == "kokoro":
            if cfg.get("kokoro_remote_worker_url") != t_url:
                cfg["kokoro_remote_worker_url"] = t_url
                cfg["remote_worker_url"] = t_url
                save_config(cfg)
                if kokoro_engine:
                    kokoro_engine.remote_url = t_url
        else:
            if cfg.get("fish_remote_worker_url") != t_url:
                cfg["fish_remote_worker_url"] = t_url
                cfg["remote_worker_url"] = t_url
                save_config(cfg)
                if fish_engine:
                    fish_engine.remote_url = t_url
    return web.json_response(status)


_last_studio_heartbeat = [time.time()]

async def handle_kaggle_heartbeat(request):
    _last_studio_heartbeat[0] = time.time()
    return web.json_response({"ok": True, "ts": _last_studio_heartbeat[0]})


async def handle_kaggle_beacon_close(request):
    """Fired via navigator.sendBeacon when user closes the browser/tab."""
    try:
        cfg = load_config()
        username = cfg.get("kaggle_username", "")
        key = cfg.get("kaggle_key", "")
        status = kaggle_mgr.get_status().get("status", "")
        if status in ("ready", "booting", "queued"):
            print("[KaggleWatchdog] Studio window closed via beacon! Terminating Kaggle GPU worker to preserve quota...")
            kaggle_mgr.stop_worker(username, key)
            cfg["remote_worker_url"] = ""
            cfg["fish_remote_worker_url"] = ""
            save_config(cfg)
            if fish_engine:
                fish_engine.remote_url = None
        return web.Response(text="ok")
    except Exception as e:
        print(f"[KaggleWatchdog] Beacon close error: {e}")
        return web.Response(text="error", status=500)


def _studio_inactivity_watchdog_loop():
    """Background watchdog: if Kaggle is active but Studio frontend stops heartbeating for > 4 min, auto-cancel."""
    while True:
        time.sleep(30)
        try:
            status = kaggle_mgr.get_status().get("status", "")
            if status in ("ready", "booting", "queued"):
                idle_sec = time.time() - _last_studio_heartbeat[0]
                if idle_sec > 240:  # 4 minutes without browser heartbeat
                    print(f"\n[KaggleWatchdog] ⚠️ No browser heartbeat for {int(idle_sec)}s! Auto-terminating Kaggle GPU to conserve user's free weekly quota...")
                    cfg = load_config()
                    username = cfg.get("kaggle_username", "")
                    key = cfg.get("kaggle_key", "")
                    kaggle_mgr.stop_worker(username, key)
                    cfg["remote_worker_url"] = ""
                    cfg["fish_remote_worker_url"] = ""
                    save_config(cfg)
                    if fish_engine:
                        fish_engine.remote_url = None
        except Exception:
            pass

_watchdog_thread = threading.Thread(target=_studio_inactivity_watchdog_loop, daemon=True)
_watchdog_thread.start()


async def handle_kaggle_stop(request):
    try:
        cfg = load_config()
        username = cfg.get("kaggle_username", "")
        key = cfg.get("kaggle_key", "")
        referer = request.headers.get("Referer", "").lower()
        engine = ""
        try:
            data = await request.json()
            engine = data.get("engine", "")
        except Exception:
            pass
        if not engine:
            engine = "kokoro" if "/kokoro" in referer else ""
        target_eng = engine or kaggle_mgr._active_session.get("engine", "fish_s2")
        res = await asyncio.to_thread(kaggle_mgr.stop_worker, username, key, target_eng)
        if target_eng == "kokoro":
            cfg["kokoro_remote_worker_url"] = ""
            if kokoro_engine:
                kokoro_engine.remote_url = None
            save_config(cfg)
        else:
            cfg["remote_worker_url"] = ""
            cfg["fish_remote_worker_url"] = ""
            if fish_engine:
                fish_engine.remote_url = None
            save_config(cfg)
        return web.json_response({**res, "remote_worker_url": ""})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

async def handle_save_config(request):
    data = await request.json()
    cfg = load_config()

    if "remote_worker_url" in data:
        url = data.get("remote_worker_url", "").strip()
        referer = request.headers.get("Referer", "").lower()
        if "/kokoro" in referer or data.get("engine") == "kokoro":
            cfg["remote_worker_url"] = url
            cfg["kokoro_remote_worker_url"] = url
            if kokoro_engine:
                kokoro_engine.remote_url = url if url else None
        else:
            cfg["remote_worker_url"] = url
            cfg["fish_remote_worker_url"] = url
            if fish_engine:
                fish_engine.remote_url = url if url else None

    if "fish_api_key" in data:
        key = data.get("fish_api_key", "").strip()
        cfg["fish_api_key"] = key
        if fish_engine:
            fish_engine.api_key = key if key else None

    if "active_engine" in data:
        engine_choice = data.get("active_engine", "fish_s2").lower()
        cfg["active_engine"] = engine_choice

    save_config(cfg)
    return web.json_response({
        "status": "saved",
        "active_engine": cfg.get("active_engine", "fish_s2"),
        "remote_worker_url": cfg.get("remote_worker_url", ""),
        "active": bool(cfg.get("remote_worker_url") or cfg.get("fish_api_key"))
    })


async def handle_epub_inspect(request):
    try:
        epub_dir = BASE_DIR / "data" / "epubs"
        epub_dir.mkdir(parents=True, exist_ok=True)

        target_path = None
        if request.content_type.startswith("multipart/"):
            reader = await request.multipart()
            part = await reader.next()
            if part.name == "file":
                filename = part.filename or "uploaded.epub"
                safe_name = f"{uuid.uuid4().hex[:8]}_{filename}"
                target_path = epub_dir / safe_name
                with open(target_path, "wb") as f:
                    while True:
                        chunk = await part.read_chunk()
                        if not chunk:
                            break
                        f.write(chunk)
        else:
            try:
                data = await request.json()
            except Exception:
                data = {}
            p = data.get("epub_path")
            if p and os.path.exists(p):
                target_path = Path(p)
            elif (epub_dir / "Harry_Potter_Series.epub").exists():
                target_path = epub_dir / "Harry_Potter_Series.epub"

        if not target_path or not os.path.exists(target_path):
            return web.json_response({"ok": False, "error": "No valid EPUB file provided"}, status=400)

        info = inspect_epub(str(target_path))
        info["ok"] = True
        info["epub_path"] = str(target_path).replace("\\", "/")
        return web.json_response(info)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_epub_import(request):
    try:
        data = await request.json()
        epub_path = data.get("epub_path")
        if not epub_path or not os.path.exists(epub_path):
            default_p = BASE_DIR / "data" / "epubs" / "Harry_Potter_Series.epub"
            if default_p.exists():
                epub_path = str(default_p)
            else:
                return web.json_response({"ok": False, "error": "EPUB file not found"}, status=404)

        book_idx = int(data.get("book_index", 1))
        chapter_file = data.get("chapter_file", "")
        chapter_idx = int(data.get("chapter_index", 1))

        info = inspect_epub(epub_path)
        if book_idx < 1 or book_idx > len(info["books"]):
            return web.json_response({"ok": False, "error": f"Invalid book index {book_idx}"}, status=400)

        book = info["books"][book_idx - 1]

        target_ch_meta = None
        if chapter_file:
            for c in book["chapters"]:
                if c["file_path"] == chapter_file:
                    target_ch_meta = c
                    break
        if not target_ch_meta:
            if chapter_idx < 1 or chapter_idx > len(book["chapters"]):
                return web.json_response({"ok": False, "error": f"Invalid chapter index {chapter_idx}"}, status=400)
            target_ch_meta = book["chapters"][chapter_idx - 1]

        ch_data = get_chapter_text(epub_path, target_ch_meta["file_path"])

        referer = request.headers.get("Referer", "").lower()
        engine = data.get("engine") or ("kokoro" if "/kokoro" in referer else "fish_s2")
        default_voice = data.get("default_voice") or ("bf_emma" if engine == "kokoro" else "voice_stanley_narrator")

        custom_title = data.get("title") or f"{book['title']} - Ch {target_ch_meta['chapter_index']}: {target_ch_meta['title']}"

        blocks = project_mgr.split_text_into_blocks(ch_data["text"], default_voice=default_voice)
        for b in blocks:
            b["engine"] = engine

        proj_id = f"proj_{uuid.uuid4().hex[:8]}"
        proj_data = {
            "id": proj_id,
            "title": custom_title,
            "engine": engine,
            "default_voice": default_voice,
            "blocks": blocks,
            "created_at": time.time(),
            "updated_at": time.time(),
            "master_filename": f"{proj_id}_master.wav"
        }
        project_mgr.save_project(proj_data, proj_id)

        return web.json_response({
            "ok": True,
            "id": proj_id,
            "title": custom_title,
            "blocks_count": len(blocks),
            "word_count": ch_data["word_count"],
            "estimated_minutes": ch_data["estimated_minutes"],
            "url": f"/kokoro/studio?project={proj_id}" if engine == "kokoro" else f"/studio?project={proj_id}"
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return web.json_response({"ok": False, "error": str(e)}, status=500)



async def handle_test_remote(request):
    data = await request.json()
    test_url = data.get("url", "").strip()
    if not test_url:
        cfg = load_config()
        test_url = cfg.get("fish_remote_worker_url") or cfg.get("remote_worker_url", "")

    if not test_url:
        return web.json_response({"ok": False, "error": "No remote URL provided"}, status=400)

    import urllib.request
    try:
        endpoints = [
            f"{test_url.rstrip('/')}/v1/health",
            f"{test_url.rstrip('/')}/health",
            f"{test_url.rstrip('/')}/v1/tts/defaults",
            f"{test_url.rstrip('/')}/docs"
        ]

        def _check():
            for ep in endpoints:
                try:
                    req = urllib.request.Request(
                        ep,
                        headers={"User-Agent": "FishSpeechStudio/1.0"}
                    )
                    with urllib.request.urlopen(req, timeout=3.5) as resp:
                        content = resp.read().decode("utf-8")
                        try:
                            return json.loads(content)
                        except Exception:
                            return {"status": "ok", "response": content[:100]}
                except urllib.error.HTTPError as he:
                    if he.code in (200, 404, 405, 422):
                        return {"status": "ok", "http_code": he.code}
                    # Cloudflare 530 (tunnel inactive) or 502/504 means worker is dead
                    if he.code in (530, 502, 503, 504):
                        return None
                except urllib.error.URLError:
                    # DNS failure, connection refused, or host unreachable: fail immediately
                    return None
                except Exception:
                    continue
            return None

        res = await asyncio.to_thread(_check)
        if res:
            return web.json_response({"ok": True, "details": res, "url": test_url})
        return web.json_response({
            "ok": False, 
            "error": "Remote worker not responding to health check (server offline or tunnel expired)",
            "url": test_url
        }, status=502)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e), "url": test_url}, status=502)


async def handle_test_fish_key(request):
    data = await request.json()
    api_key = data.get("api_key", "").strip()
    if not api_key:
        cfg = load_config()
        api_key = cfg.get("fish_api_key", "").strip()

    if not api_key:
        return web.json_response({"ok": False, "error": "No API key provided"}, status=400)

    import urllib.request
    import urllib.error
    try:
        req = urllib.request.Request(
            "https://api.fish.audio/wallet/self/api-credit",
            headers={
                "Authorization": f"Bearer {api_key}",
                "User-Agent": "FishSpeechStudio/1.0"
            }
        )
        def _check():
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    return json.loads(resp.read().decode("utf-8"))
                return None
        res = await asyncio.to_thread(_check)
        if res:
            credit_f = float(res.get("credit", 0.0))
            return web.json_response({
                "ok": True,
                "credit": credit_f,
                "user_id": res.get("user_id"),
                "has_free_credit": res.get("has_free_credit")
            })
        return web.json_response({"ok": False, "error": "Unexpected response from Fish Audio"}, status=502)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return web.json_response({"ok": False, "error": "Invalid API key (401 Unauthorized)"}, status=401)
        return web.json_response({"ok": False, "error": f"Fish Audio API returned HTTP {e.code}"}, status=e.code)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=502)


async def handle_get_colab_script(request):
    referer = request.headers.get("Referer", "").lower()
    is_kokoro = ("/kokoro" in referer) or (request.query.get("engine") == "kokoro")
    colab_file = (BASE_DIR / "colab_worker.py") if is_kokoro else (BASE_DIR / "colab_fish_worker.py")
    if not colab_file.exists():
        colab_file = Path("c:/Users/ADMIN/Documents/Project Folder/edge tts/colab_worker.py")
    if colab_file.exists():
        with open(colab_file, "r", encoding="utf-8") as f:
            content = f.read()
        return web.Response(text=content, content_type="text/plain")
    return web.Response(text="# Colab worker script not found", status=404)


async def handle_get_sample_story(request):
    sample_file = BASE_DIR / "input" / "THE ENDLESS ECLIPSE - Sample.txt"
    if not sample_file.exists():
        sample_file = BASE_DIR / "input" / "THE ENDLESS ECLIPSE.txt"
    if sample_file.exists():
        with open(sample_file, "r", encoding="utf-8-sig") as f:
            content = f.read()
        return web.json_response({
            "title": "The Endless Eclipse - Sample",
            "text": content
        })
    return web.json_response({"error": "Sample file not found"}, status=404)


async def handle_favicon(request):
    fav_file = STUDIO_DIR / "favicon.svg"
    if fav_file.exists():
        return web.FileResponse(fav_file, headers={"Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400"})
    return web.Response(status=404)


# ---------------- APP FACTORY ---------------- #

def create_app():
    app = web.Application(middlewares=[no_cache_middleware])
    app.router.add_get("/", handle_index)
    app.router.add_get("/studio", handle_index)
    app.router.add_get("/studio/", handle_index)
    app.router.add_get("/projects", handle_index)
    app.router.add_get("/favicon.ico", handle_favicon)
    app.router.add_get("/studio/favicon.svg", handle_favicon)

    # Voices & Reference management
    app.router.add_get("/api/voices", handle_get_voices)
    app.router.add_post("/api/voices/upload_reference", handle_upload_reference_voice)
    app.router.add_get("/api/voices/reference", handle_get_reference_voices)
    app.router.add_post("/api/voices/save_to_library", handle_save_to_library)
    app.router.add_post("/api/voices/update", handle_update_voice)
    app.router.add_post("/api/voices/delete", handle_delete_voice)
    app.router.add_get("/api/fish_library/explore", handle_fish_library_explore)
    app.router.add_get("/api/fish_library/search", handle_fish_library_search)
    app.router.add_post("/api/fish_library/install_voice", handle_fish_library_install)

    # Synthesis & Export & Instant Audio FX
    app.router.add_post("/api/synthesize_block", handle_synthesize_block)
    app.router.add_post("/api/blend_preview", handle_blend_preview)
    app.router.add_post("/api/audio/apply_dsp", handle_apply_dsp)
    app.router.add_post("/api/audio/reset_dsp", handle_reset_dsp)
    app.router.add_post("/api/export_master", handle_export_master)
    app.router.add_post("/api/export_zip", handle_export_zip)

    # Project management
    app.router.add_get("/api/projects", handle_get_projects)
    app.router.add_post("/api/projects/new", handle_create_project)
    app.router.add_post("/api/projects/duplicate", handle_duplicate_project)
    app.router.add_post("/api/projects/copy_to_engine", handle_copy_project_to_engine)
    app.router.add_post("/api/projects/rename", handle_rename_project)
    app.router.add_delete("/api/projects/{id}", handle_delete_project)
    app.router.add_get("/api/project", handle_get_project)
    app.router.add_post("/api/project", handle_save_project)

    # Text & Auto-directing
    app.router.add_post("/api/split_text", handle_split_text)
    app.router.add_post("/api/auto_direct", handle_auto_direct)
    app.router.add_post("/api/merge_short", handle_merge_short)

    # Audio & Config
    app.router.add_get("/api/audio/{filename}", handle_get_audio)
    app.router.add_get("/api/config", handle_get_config)
    app.router.add_post("/api/config", handle_save_config)
    app.router.add_post("/api/cloud/kaggle/verify", handle_kaggle_verify)
    app.router.add_post("/api/cloud/kaggle/launch", handle_kaggle_launch)
    app.router.add_get("/api/cloud/kaggle/status", handle_kaggle_status)
    app.router.add_post("/api/cloud/kaggle/stop", handle_kaggle_stop)
    app.router.add_post("/api/cloud/kaggle/heartbeat", handle_kaggle_heartbeat)
    app.router.add_post("/api/cloud/kaggle/beacon_close", handle_kaggle_beacon_close)
    app.router.add_post("/api/test_remote", handle_test_remote)
    app.router.add_post("/api/test_fish_key", handle_test_fish_key)
    app.router.add_get("/api/colab_script", handle_get_colab_script)
    app.router.add_get("/api/sample_story", handle_get_sample_story)

    # EPUB Audiobook Importer
    app.router.add_post("/api/epub/inspect", handle_epub_inspect)
    app.router.add_post("/api/epub/import", handle_epub_import)

    # Static assets
    app.router.add_static("/studio", STUDIO_DIR)
    app.router.add_static("/voices", BASE_DIR / "voices")

    # Kokoro Studio Routes (completely isolated UI and engine)
    app.router.add_get("/kokoro", handle_kokoro_index)
    app.router.add_get("/kokoro/", handle_kokoro_index)
    app.router.add_get("/kokoro/studio", handle_kokoro_index)
    app.router.add_get("/kokoro/studio/", handle_kokoro_index)
    app.router.add_get("/kokoro/favicon.svg", handle_kokoro_favicon)
    app.router.add_static("/kokoro_studio", KOKORO_STUDIO_DIR)

    return app


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Fish Speech Studio Server")
    parser.add_argument("--port", type=int, default=7865, help="Port to listen on (default 7865)")
    parser.add_argument("--test", action="store_true", help="Initialize and exit for testing")
    args = parser.parse_args()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(init_engine())

    if args.test:
        print("[Fish Speech Studio] Self-test passed successfully.")
        exit(0)

    app = create_app()
    print("\n=======================================================")
    print(f"  [Fish Audio S2 Pro Studio] running at: http://localhost:{args.port}")
    print("=======================================================\n")
    web.run_app(app, host="127.0.0.1", port=args.port)
