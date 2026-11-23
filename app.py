import os
import hashlib
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
from core.engine_registry import initialize_engine_registry, engine_registry
from core.kaggle_cloud_manager import KaggleCloudManager
from core.tier_manager import TierManager
from core.dns_fallback import setup_resilient_dns

# Ensure resilient DNS is active
setup_resilient_dns()
from core.project_manager import ProjectManager
from core.local_gpu_manager import LocalGpuManager
from core.epub_parser import inspect_epub, get_chapter_text

BASE_DIR = Path(__file__).resolve().parent
STUDIO_DIR = BASE_DIR / "studio"
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
local_gpu_mgr = LocalGpuManager(BASE_DIR)
tier_mgr = TierManager()




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
        "fish_api_model": "drama-3",
        "active_engine": "fish_s2"
    }


def save_config(cfg: dict):
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


async def init_engine():
    global fish_engine, kokoro_engine
    cfg = load_config()

    # Load master platform key for SaaS subscriptions (env var takes top priority, config fallback)
    platform_key = (os.environ.get("FISH_PLATFORM_API_KEY") or cfg.get("fish_api_key", "")).strip()
    if platform_key:
        tier_mgr.state["platform_fish_api_key"] = platform_key
        print("[SaaS Engine] Platform master Drama 3 API key loaded successfully.")

    # Initialize Fish Audio S2 Pro / Drama 3 Engine
    fish_remote = (cfg.get("fish_remote_worker_url") or cfg.get("remote_worker_url", "")).strip()
    fish_key = cfg.get("fish_api_key", "").strip()
    # If in BYOK mode, use user's explicit key; otherwise resolve via TierManager
    active_fish_key = tier_mgr.resolve_api_key() or fish_key
    fish_model = (cfg.get("fish_api_model") or "drama-3").strip()
    try:
        fish_engine = FishEngine(remote_url=fish_remote, api_key=active_fish_key, model=fish_model)
        print(f"[Fish Speech Studio] Fish Audio engine ready (Worker: {fish_remote or 'None'}, Active Tier: {tier_mgr.get_tier()}, Model: {fish_model})")
    except Exception as e:
        print(f"[Fish Speech Studio] Warning: FishEngine init error: {e}")

    # Initialize Kokoro Engine
    kokoro_remote = (cfg.get("kokoro_remote_worker_url") or cfg.get("remote_worker_url", "")).strip()
    try:
        kokoro_engine = KokoroEngine(remote_url=kokoro_remote)
        print(f"[Kokoro Studio] Kokoro engine ready (Worker: {kokoro_remote or 'Local ONNX'})")
    except Exception as e:
        print(f"[Kokoro Studio] Warning: KokoroEngine init error: {e}")

    # Initialize Multi-Engine Registry (Fish Speech, Kokoro 82M, Microsoft Edge TTS)
    try:
        initialize_engine_registry(fish_engine=fish_engine, kokoro_engine=kokoro_engine)
        print("[Multi-Engine] Engine registry initialized with Fish Speech, Kokoro, and Edge TTS.")
    except Exception as e:
        print(f"[Multi-Engine] Warning: Engine registry init error: {e}")

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
    qs = request.query_string
    dest = f"/studio?{qs}" if qs else "/studio"
    raise web.HTTPMovedPermanently(dest)


async def handle_kokoro_favicon(request):
    fav_file = STUDIO_DIR / "favicon.svg"
    if fav_file.exists():
        return web.FileResponse(fav_file, headers={"Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400"})
    return web.Response(status=404)


async def handle_get_engines(request):
    """Returns list of registered engines and their capabilities."""
    engines = engine_registry.list_engines()
    cfg = load_config()
    return web.json_response({
        "engines": engines,
        "active_engine": cfg.get("active_engine", "fish_s2")
    })


async def handle_get_voices(request):
    engine_param = (request.query.get("engine") or "").lower()
    referer = request.headers.get("Referer", "").lower()
    is_kokoro_only = (engine_param == "kokoro") or (not engine_param and "/kokoro" in referer)

    # 1. Edge TTS voices
    if engine_param in ("edge", "edge_tts", "ms_edge"):
        edge_voices = engine_registry.get_voices_for_engine("edge_tts")
        return web.json_response(edge_voices)

    # 2. Load Kokoro Voices (Fast on-device / client narration)
    k_voices = []
    if VOICES_FILE.exists():
        try:
            with open(VOICES_FILE, "r", encoding="utf-8") as f:
                k_voices = json.load(f)
                for kv in k_voices:
                    kv["engine"] = "kokoro"
                    kv["engine_label"] = "Fast (Kokoro 82M)"
                    if not kv.get("badge"):
                        kv["badge"] = kv.get("name", "KO")[:2].upper()
                    if not kv.get("color"):
                        kv["color"] = "#6366f1"
        except Exception as e:
            print(f"[app] Error loading Kokoro voices: {e}")

    if is_kokoro_only:
        return web.json_response(k_voices)

    # 3. Load Fish Speech Voices (Cinema Drama 3 acting)
    voices = []
    if FISH_VOICES_FILE.exists():
        try:
            with open(FISH_VOICES_FILE, "r", encoding="utf-8") as f:
                voices = json.load(f)
                for fv in voices:
                    fv["engine"] = "fish_s2"
                    fv["engine_label"] = "Cinema (Drama 3)"
        except Exception as e:
            print(f"[app] Error loading Fish voices: {e}")

    for v in voices:
        v["engine"] = "fish_s2"
        v["engine_label"] = "Cinema (Drama 3)"
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
                "engine_label": "Cinema (Drama 3)",
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

    if engine_param in ("fish", "fish_s2"):
        return web.json_response(voices)

    edge_voices = engine_registry.get_voices_for_engine("edge_tts")
    eleven_voices = engine_registry.get_voices_for_engine("elevenlabs")
    cartesia_voices = engine_registry.get_voices_for_engine("cartesia")
    openai_voices = engine_registry.get_voices_for_engine("openai")

    if engine_param in ("eleven", "elevenlabs"):
        return web.json_response(eleven_voices)
    if engine_param in ("cartesia", "sonic"):
        return web.json_response(cartesia_voices)
    if engine_param in ("openai", "gpt"):
        return web.json_response(openai_voices)

    # Unified voice catalog: Cinema (Drama 3) + Fast (Kokoro) + Free (Edge TTS) + Pro Commercial (ElevenLabs, Cartesia, OpenAI)
    return web.json_response(voices + k_voices + edge_voices + eleven_voices + cartesia_voices + openai_voices)


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
        model = (data.get("model") or "").strip()

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

        # Engine routing: check if Edge TTS or Kokoro is requested
        voice_id = data.get("voice_id")
        blend_weights = data.get("blend_weights")
        referer = request.headers.get("Referer", "").lower()
        is_edge = (block_engine in ("edge_tts", "edge", "ms_edge")) or (voice_id and "Neural" in str(voice_id))
        is_kokoro = not is_edge and ((block_engine == "kokoro") or ("/kokoro" in referer) or (blend_weights is not None))
        if not is_kokoro and not is_edge and voice_id:
            if str(voice_id).startswith(("am_", "af_", "bm_", "bf_", "blend_")):
                is_kokoro = True

        if is_edge:
            task_key = f"edge::{text}::{voice_id or 'en-US-GuyNeural'}::{speed}::{gain}::{pitch_shift}::{warmth}::{clarity}::{reverb}::{radio_fx}::{fx_filter}"
            if not force_refresh and task_key in in_flight_synthesis_futures:
                print(f"[Edge Studio] [WAIT] Task already rendering for: '{text[:50]}...'. Attaching to active job.", flush=True)
                try:
                    res = await in_flight_synthesis_futures[task_key]
                    return web.json_response(res)
                except Exception as e:
                    return web.json_response({"error": str(e)}, status=500)

            loop = asyncio.get_running_loop()
            fut = loop.create_future()
            in_flight_synthesis_futures[task_key] = fut

            try:
                edge_adapter = engine_registry.get_engine("edge_tts")
                res = await asyncio.to_thread(
                    edge_adapter.synthesize_block,
                    text=text,
                    voice_id=voice_id or "en-US-GuyNeural",
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
                if isinstance(res, dict) and not res.get("error"):
                    user = get_current_user(request)
                    res["tier_status"] = tier_mgr.get_public_status(user=user)
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

        if block_engine in ("elevenlabs", "cartesia", "openai"):
            task_key = f"{block_engine}::{model}::{text}::{voice_id or ''}::{speed}::{gain}::{pitch_shift}::{warmth}::{clarity}::{reverb}::{radio_fx}::{fx_filter}"
            if not force_refresh and task_key in in_flight_synthesis_futures:
                try:
                    res = await in_flight_synthesis_futures[task_key]
                    return web.json_response(res)
                except Exception as e:
                    return web.json_response({"error": str(e)}, status=500)

            loop = asyncio.get_running_loop()
            fut = loop.create_future()
            in_flight_synthesis_futures[task_key] = fut

            try:
                adapter = engine_registry.get_engine(block_engine)
                res = await asyncio.to_thread(
                    adapter.synthesize_block,
                    text=text,
                    voice_id=voice_id,
                    speed=speed,
                    gain=gain,
                    pitch_shift=pitch_shift,
                    warmth=warmth,
                    clarity=clarity,
                    reverb=reverb,
                    radio_fx=radio_fx,
                    fx_filter=fx_filter,
                    force_refresh=force_refresh,
                    model=model
                )
                if not fut.done():
                    fut.set_result(res)
                if isinstance(res, dict) and not res.get("error"):
                    user = get_current_user(request)
                    res["tier_status"] = tier_mgr.get_public_status(user=user)
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
                    if isinstance(res, dict) and not res.get("error"):
                        user = get_current_user(request)
                        res["tier_status"] = tier_mgr.get_public_status(user=user)
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

        user = get_current_user(request)

        # SaaS Tier & Quota Check for Cinema Drama 3
        word_count = len(text.split())
        tier_allowed, tier_info = tier_mgr.can_synthesize_fish(word_count, user=user)
        if not tier_allowed:
            return web.json_response({
                "error": tier_info,
                "needs_tier_upgrade": True,
                "tier_status": tier_mgr.get_public_status(user=user)
            }, status=403)

        # Resolve correct Fish API key (Platform master key or user's BYOK key)
        tier_api_key = tier_mgr.resolve_api_key(user=user)
        if tier_api_key and fish_engine:
            fish_engine.api_key = tier_api_key

        # Unique task key for in-flight deduplication
        prev_a = data.get("prev_audio") or ""
        task_key = f"{block_engine}::{model}::{text}::{voice_id or ''}::{emotion_tag or ''}::{reference_audio or ''}::{prev_a}::{speed}::{temperature}::{top_p}"

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
                    enable_rolling_context=True,
                    model=model
                )
                if not fut.done():
                    fut.set_result(res)
                if isinstance(res, dict) and not res.get("error"):
                    is_trial = tier_info.startswith("trial_")
                    tier_mgr.record_usage(word_count, is_trial=is_trial, user=user)
                    res["tier_status"] = tier_mgr.get_public_status(user=user)
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


async def handle_check_cache(request):
    """
    Fast disk-cache check for blocks without running neural inference or acquiring GPU locks.
    Instantly returns whether a rendered audio file (or raw audio that can be sculpted) exists on disk.
    If a raw audio file exists, it instantaneously produces the DSP audio if needed so the URL is immediately playable.
    """
    try:
        try:
            data = await request.json()
        except Exception as e:
            return web.json_response({"error": f"Invalid JSON payload: {e}"}, status=400)

        raw_blocks = data.get("blocks")
        if raw_blocks is None:
            if "block" in data:
                raw_blocks = [data["block"]]
            else:
                raw_blocks = [data]

        cfg = load_config()
        default_engine = cfg.get("active_engine", "fish_s2")
        referer = request.headers.get("Referer", "").lower()
        if "/kokoro" in referer:
            default_engine = "kokoro"

        def _num(v, default=0.0):
            if v is None:
                return default
            try:
                return float(v)
            except (ValueError, TypeError):
                return default

        results = []

        for item in raw_blocks:
            idx = item.get("index")
            text = (item.get("text") or "").strip()
            if not text:
                results.append({"index": idx, "cached": False, "reason": "empty_text"})
                continue

            block_engine = (item.get("engine") or default_engine).lower()
            voice_id = item.get("voice_id")
            blend_weights = item.get("blend_weights")

            is_edge = (block_engine in ("edge_tts", "edge", "ms_edge")) or ("Neural" in str(voice_id))
            is_kokoro = not is_edge and ((block_engine == "kokoro") or (blend_weights is not None) or (voice_id and str(voice_id).startswith(("am_", "af_", "bm_", "bf_", "blend_"))))

            speed = _num(item.get("speed"), 1.0 if not is_kokoro else 0.90)
            gain = _num(item.get("gain"), 1.0)
            pitch_shift = _num(item.get("pitch_shift"), 0.0)
            warmth = _num(item.get("warmth"), 0.0)
            clarity = _num(item.get("clarity"), 0.0)
            reverb = _num(item.get("reverb"), 0.0)
            radio_fx = bool(item.get("radio_fx", False))
            fx_filter = str(item.get("fx_filter") or ("radio" if radio_fx else "none")).strip().lower()

            needs_dsp = (
                gain != 1.0 or abs(speed - (1.0 if not is_kokoro else 0.90)) >= 0.03 or
                pitch_shift != 0.0 or warmth != 0.0 or clarity != 0.0 or reverb != 0.0 or fx_filter != "none"
            )

            if is_edge:
                valid_voice = (voice_id or "").strip()
                if not valid_voice or "Neural" not in valid_voice:
                    valid_voice = "en-US-GuyNeural"

                speed_pct = int(round((speed - 1.0) * 100))
                rate_str = f"{speed_pct:+d}%"

                pitch_hz = int(round(pitch_shift * 5))
                pitch_str = f"{pitch_hz:+d}Hz"

                fx_filter_s = str(fx_filter or ("radio" if radio_fx else "none")).strip().lower()
                pitch_shift_f = float(pitch_shift)
                warmth_f = float(warmth)
                clarity_f = float(clarity)
                reverb_f = float(reverb)

                cache_key = (
                    f"edge::{text}::{valid_voice}::{rate_str}::{pitch_str}::{gain}::"
                    f"{pitch_shift_f}::{warmth_f}::{clarity_f}::{reverb_f}::{radio_fx}::{fx_filter_s}"
                )
                c_hash = hashlib.md5(cache_key.encode("utf-8")).hexdigest()
                c_file = CACHE_DIR / f"{c_hash}.wav"

                if not c_file.exists():
                    take_files = list(CACHE_DIR.glob(f"{c_hash}_*.wav"))
                    if take_files:
                        take_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                        c_file = take_files[0]
                        c_hash = c_file.stem

                if c_file.exists():
                    try:
                        info = sf.info(str(c_file))
                        results.append({
                            "index": idx,
                            "cached": True,
                            "hash": c_hash,
                            "audio_url": f"/api/audio/{c_hash}.wav",
                            "duration": round(info.duration, 2),
                            "engine": "edge_tts"
                        })
                        continue
                    except Exception:
                        pass
                results.append({"index": idx, "cached": False, "hash": c_hash, "engine": "edge_tts"})

            elif is_kokoro:
                voice_tag = voice_id or "blend_fenrir_onyx"
                if blend_weights and voice_id not in getattr(kokoro_engine, "preset_blends", {}):
                    voice_tag = "blend_" + "_".join(f"{k}:{v:.2f}" for k, v in sorted(blend_weights.items()))

                cache_str = (
                    f"{text}__{voice_tag}__{speed:.2f}__{gain:.2f}__"
                    f"{pitch_shift:.1f}__{warmth:.1f}__{clarity:.1f}__{reverb:.2f}__{fx_filter}"
                )
                c_hash = hashlib.md5(cache_str.encode("utf-8")).hexdigest()
                c_file = CACHE_DIR / f"{c_hash}.wav"

                if not c_file.exists():
                    take_files = list(CACHE_DIR.glob(f"{c_hash}_*.wav"))
                    if take_files:
                        take_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                        c_file = take_files[0]
                        c_hash = c_file.stem

                if c_file.exists():
                    try:
                        info = sf.info(str(c_file))
                        results.append({
                            "index": idx,
                            "cached": True,
                            "hash": c_hash,
                            "audio_url": f"/api/audio/{c_hash}.wav",
                            "duration": round(info.duration, 2),
                            "engine": "kokoro"
                        })
                        continue
                    except Exception:
                        pass
                results.append({"index": idx, "cached": False, "hash": c_hash, "engine": "kokoro"})

            elif block_engine in ("elevenlabs", "cartesia", "openai"):
                model_val = item.get("model") or ""
                target_voice = voice_id or ""
                pitch_shift_f = float(pitch_shift)
                warmth_f = float(warmth)
                clarity_f = float(clarity)
                reverb_f = float(reverb)

                if block_engine == "elevenlabs":
                    m_id = "eleven_flash_v2_5"
                    if model_val in ("v4", "v4_cinematic", "v4-cinematic"):
                        m_id = "eleven_multilingual_v2"
                    elif model_val in ("v3", "eleven_multilingual_v1"):
                        m_id = "eleven_multilingual_v1"
                    elif model_val in ("flash", "flash_v2.5", "eleven_flash_v2_5"):
                        m_id = "eleven_flash_v2_5"
                    elif model_val:
                        m_id = str(model_val)
                    clean_t = re.sub(r'\[.*?\]', '', text).strip()
                    c_key = f"eleven::{clean_t}::{target_voice}::{m_id}::{speed}::{gain}::{pitch_shift_f}::{warmth_f}::{clarity_f}::{reverb_f}::{radio_fx}::{fx_filter}"
                elif block_engine == "cartesia":
                    m_id = "sonic-english"
                    if model_val in ("sonic_4", "sonic-4"):
                        m_id = "sonic-4"
                    elif model_val in ("sonic_3.6", "sonic-3.6", "sonic-english"):
                        m_id = "sonic-english"
                    elif model_val:
                        m_id = str(model_val)
                    clean_t = re.sub(r'\[.*?\]', '', text).strip()
                    c_key = f"cartesia::{clean_t}::{target_voice}::{m_id}::{speed}::{gain}::{pitch_shift_f}::{warmth_f}::{clarity_f}::{reverb_f}::{radio_fx}::{fx_filter}"
                else: # openai
                    m_id = "tts-1"
                    if model_val in ("tts-1", "tts-1-hd"):
                        m_id = str(model_val)
                    elif model_val in ("gpt-4o-mini-tts", "gpt-4o", "gpt-4o-mini"):
                        m_id = "gpt-4o-mini-tts"
                    elif model_val:
                        m_id = str(model_val)
                    clean_t = re.sub(r'\[.*?\]', '', text).strip()
                    speed_clamped = max(0.25, min(4.0, float(speed)))
                    c_key = f"openai::{clean_t}::{target_voice}::{m_id}::{speed_clamped}::{gain}::{pitch_shift_f}::{warmth_f}::{clarity_f}::{reverb_f}::{radio_fx}::{fx_filter}"

                c_hash = hashlib.md5(c_key.encode("utf-8")).hexdigest()
                c_file = CACHE_DIR / f"{c_hash}.wav"
                if c_file.exists():
                    try:
                        info = sf.info(str(c_file))
                        results.append({
                            "index": idx,
                            "cached": True,
                            "hash": c_hash,
                            "audio_url": f"/api/audio/{c_hash}.wav",
                            "duration": round(info.duration, 2),
                            "engine": block_engine
                        })
                        continue
                    except Exception:
                        pass
                results.append({"index": idx, "cached": False, "hash": c_hash, "engine": block_engine})

            else:
                # Fish S2
                emotion_tag = item.get("emotion_tag")
                reference_audio = item.get("reference_audio")
                reference_text = item.get("reference_text")
                item_model = item.get("model")
                temp = max(0.1, min(1.0, _num(item.get("temperature"), 0.70)))
                top_p = max(0.1, min(1.0, _num(item.get("top_p"), 0.85)))

                formatted_text = fish_engine.format_emotion_text(text, emotion_tag)
                ref_path, r_text = fish_engine.resolve_reference_audio(reference_audio, reference_text, voice_id)

                c_hash = fish_engine.compute_cache_hash(
                    formatted_text, ref_path, r_text, speed, temp, top_p,
                    gain, pitch_shift, warmth, clarity, reverb, fx_filter,
                    model=item_model
                )
                c_file = CACHE_DIR / f"{c_hash}.wav"

                # Check if exact hash exists
                if not c_file.exists():
                    # Check if any take exists
                    take_files = list(CACHE_DIR.glob(f"{c_hash}_*.wav"))
                    if take_files:
                        take_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                        c_file = take_files[0]
                        c_hash = c_file.stem

                if c_file.exists():
                    try:
                        info = sf.info(str(c_file))
                        results.append({
                            "index": idx,
                            "cached": True,
                            "hash": c_hash,
                            "audio_url": f"/api/audio/{c_hash}.wav",
                            "duration": round(info.duration, 2),
                            "engine": "fish_s2"
                        })
                        continue
                    except Exception:
                        pass

                # Check raw cache
                raw_hash = fish_engine.compute_cache_hash(
                    formatted_text, ref_path, r_text, 1.0, temp, top_p,
                    1.0, 0.0, 0.0, 0.0, 0.0, "none",
                    model=item_model
                )
                raw_file = CACHE_DIR / f"raw_{raw_hash}.wav"
                raw_hash_file = CACHE_DIR / f"raw_{c_hash}.wav"

                source_raw = None
                if raw_file.exists():
                    source_raw = raw_file
                elif raw_hash_file.exists():
                    source_raw = raw_hash_file
                else:
                    raw_takes = list(CACHE_DIR.glob(f"raw_{c_hash}_*.wav"))
                    if raw_takes:
                        raw_takes.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                        source_raw = raw_takes[0]

                if source_raw and source_raw.exists():
                    try:
                        base_samples, sr = sf.read(str(source_raw))
                        if needs_dsp:
                            from core.audio_dsp import process_audio_fx
                            processed = base_samples * gain if gain != 1.0 else base_samples.copy()
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
                        else:
                            processed = base_samples
                        sf.write(str(c_file), processed, sr)
                        results.append({
                            "index": idx,
                            "cached": True,
                            "hash": c_hash,
                            "audio_url": f"/api/audio/{c_hash}.wav",
                            "duration": round(len(processed) / sr, 2),
                            "engine": "fish_s2"
                        })
                        continue
                    except Exception as e:
                        print(f"[CheckCache] Instant DSP from raw failed: {e}")

                results.append({"index": idx, "cached": False, "hash": c_hash, "engine": "fish_s2"})

        return web.json_response({"results": results})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


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


async def handle_cache_client_audio(request):
    """
    Receives client-side synthesized audio (e.g. from in-browser kokoro-js WebGPU)
    and stores it in the server CACHE_DIR and updates the project block,
    enabling $0 server CPU compute while preserving full export capabilities.
    """
    try:
        reader = await request.multipart()
        audio_bytes = None
        hash_val = None
        project_id = None
        block_id = None
        duration = None

        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == 'audio':
                audio_bytes = await part.read()
            elif part.name == 'hash':
                hash_val = (await part.text()).strip()
            elif part.name == 'project_id':
                project_id = (await part.text()).strip()
            elif part.name == 'block_id':
                block_id = (await part.text()).strip()
            elif part.name == 'duration':
                try:
                    duration = float(await part.text())
                except Exception:
                    pass

        if not audio_bytes or not hash_val:
            return web.json_response({"ok": False, "error": "audio and hash required"}, status=400)

        safe_hash = re.sub(r'[^a-zA-Z0-9_\-]', '', hash_val)
        wav_file = CACHE_DIR / f"{safe_hash}.wav"
        with open(wav_file, "wb") as f:
            f.write(audio_bytes)

        # Update project JSON block if project_id and block_id were supplied
        if project_id and block_id:
            proj = project_mgr.get_project(project_id)
            if proj and proj.get("blocks"):
                updated = False
                for b in proj["blocks"]:
                    if str(b.get("id")) == str(block_id):
                        b["audio_url"] = f"/api/audio/{safe_hash}.wav"
                        b["cachedAudioUrl"] = f"/api/audio/{safe_hash}.wav"
                        b["hash"] = safe_hash
                        if duration:
                            b["duration"] = duration
                        updated = True
                        break
                if updated:
                    project_mgr.save_project(proj, project_id)

        return web.json_response({
            "ok": True,
            "hash": safe_hash,
            "audio_url": f"/api/audio/{safe_hash}.wav"
        })
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


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
    is_edge = (b_engine in ("edge_tts", "edge", "ms_edge")) or ("Neural" in voice_id)
    is_kokoro = not is_edge and ((b_engine == "kokoro") or voice_id.startswith(("am_", "af_", "bm_", "bf_", "blend_")))

    if is_edge:
        edge_adapter = engine_registry.get_engine("edge_tts")
        res = edge_adapter.synthesize_block(
            text=text,
            voice_id=voice_id or "en-US-GuyNeural",
            speed=float(b.get("speed", 1.0) or 1.0),
            gain=float(b.get("gain", 1.0) or 1.0),
            pitch_shift=float(b.get("pitch_shift", 0.0) or 0.0),
            warmth=float(b.get("warmth", 0.0) or 0.0),
            clarity=float(b.get("clarity", 0.0) or 0.0),
            reverb=float(b.get("reverb", 0.0) or 0.0),
            radio_fx=bool(b.get("radio_fx", False)),
            fx_filter=str(b.get("fx_filter") or "none").strip().lower()
        )
    elif is_kokoro:
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
    elif b_engine in ("elevenlabs", "cartesia", "openai"):
        adapter = engine_registry.get_engine(b_engine)
        res = adapter.synthesize_block(
            text=text,
            voice_id=voice_id,
            speed=float(b.get("speed", 1.0) or 1.0),
            gain=float(b.get("gain", 1.0) or 1.0),
            pitch_shift=float(b.get("pitch_shift", 0.0) or 0.0),
            warmth=float(b.get("warmth", 0.0) or 0.0),
            clarity=float(b.get("clarity", 0.0) or 0.0),
            reverb=float(b.get("reverb", 0.0) or 0.0),
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
    user = get_current_user(request)
    engine_filter = request.query.get("engine")
    is_local = request.remote in ("127.0.0.1", "::1", "localhost") or not request.remote
    owner_id = user["user_id"] if (user and not user.get("is_admin") and not is_local) else None
    projs = project_mgr.list_projects(engine=engine_filter, owner_id=owner_id)
    return web.json_response(projs)


_recent_created_projects = {}
ACTIVE_JOBS: Dict[str, Dict[str, Any]] = {}

async def handle_job_progress(request):
    job_id = request.query.get("job_id", "").strip()
    if not job_id:
        return web.json_response({"ok": False, "error": "Missing job_id"}, status=400)
    job = ACTIVE_JOBS.get(job_id)
    if not job:
        return web.json_response({"ok": True, "job": {"status": "pending", "percent": 5, "message": "Initializing AI Director..."}})
    return web.json_response({"ok": True, "job": job})

async def handle_create_project(request):
    try:
        data = await request.json()
        title = data.get("title", "Untitled Project").strip() or "Untitled Project"
        raw_text = data.get("text", "").strip()
        defaults = data.get("defaults") or data.get("default_settings") or {}
        job_id = data.get("job_id", "").strip()
        folder_id = data.get("folder_id")
        acting_intensity = data.get("acting_intensity", "balanced")
        analysis_temperature = float(data.get("analysis_temperature", 0.6))
        split_long_emotional_blocks = bool(data.get("split_long_emotional_blocks", True))
        tag_placement = data.get("tag_placement", "pill")
        cast_mode = data.get("cast_mode", "multi")
        tier = (data.get("tier") or "standard").lower().strip()
        if tier not in ("standard", "cinema_pro"):
            tier = "standard"
        
        default_engine = (data.get("engine") or "").lower().strip()
        if not default_engine:
            referer = request.headers.get("Referer", "").lower()
            if tier == "cinema_pro":
                default_engine = "fish_s2"
            else:
                default_engine = "kokoro" if "/kokoro" in referer else "edge_tts"

        default_voice = data.get("default_voice") or defaults.get("voice_id", "voice_stanley_narrator" if default_engine == "fish_s2" else ("en-US-GuyNeural" if default_engine == "edge_tts" else "blend_fenrir_onyx"))

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

        ai_direct = bool(data.get("ai_direct", False))
        characters = data.get("characters", [])

        if job_id:
            ACTIVE_JOBS[job_id] = {
                "status": "processing",
                "percent": 8,
                "step": "init",
                "message": "Initializing project blocks...",
                "characters": [],
                "total_blocks": len(blocks),
                "current_chunk": 0,
                "total_chunks": 1
            }

        def _on_create_progress(p_data):
            if job_id:
                ACTIVE_JOBS[job_id] = {
                    "status": "done" if p_data.get("percent", 0) >= 100 else "processing",
                    **p_data
                }

        if ai_direct and len(blocks) > 0:
            try:
                if default_engine == "kokoro":
                    try:
                        with open(BASE_DIR / "core" / "voices_metadata.json", "r", encoding="utf-8") as f:
                            k_raw = json.load(f)
                            voices = k_raw if isinstance(k_raw, list) else [{"id": k, **v} for k, v in k_raw.items()]
                    except Exception:
                        voices = []
                else:
                    try:
                        with open(BASE_DIR / "core" / "fish_voices_metadata.json", "r", encoding="utf-8") as f:
                            voices = json.load(f)
                    except Exception:
                        voices = []

                cfg = load_config()
                prov = data.get("ai_provider")
                model = data.get("ai_model") or ""
                if not prov:
                    if "gemini" in model.lower():
                        prov = "gemini"
                    elif any(x in model.lower() for x in ["llama", "mixtral", "gemma", "whisper", "gpt-oss"]):
                        prov = "groq"
                    elif "gpt-" in model.lower():
                        prov = "openai"
                    elif "ollama" in model.lower():
                        prov = "ollama"
                    else:
                        prov = cfg.get("default_llm_provider", "gemini")
                provider = prov
                api_key = data.get("ai_api_key") or cfg.get(f"{prov}_api_key") or os.environ.get(f"{prov.upper()}_API_KEY", "")

                from core.ai_director import AIDirector
                director = AIDirector()

                def _direct_sync():
                    return director.direct_story(
                        blocks=blocks,
                        voices=voices,
                        provider=provider,
                        api_key=api_key,
                        model=model,
                        split_dialogue=data.get("split_dialogue", True),
                        cast_voices=True,
                        add_emotions=data.get("add_emotions", True),
                        default_narrator_voice=default_voice,
                        progress_callback=_on_create_progress,
                        acting_intensity=acting_intensity,
                        analysis_temperature=analysis_temperature,
                        split_long_emotional_blocks=split_long_emotional_blocks,
                        tag_placement=tag_placement,
                        production_mode=cast_mode
                    )

                direct_res = await asyncio.to_thread(_direct_sync)
                if direct_res.get("ok"):
                    blocks = direct_res.get("blocks", blocks)
                    characters = direct_res.get("characters", [])
                    for b in blocks:
                        b["engine"] = default_engine
            except Exception as direct_err:
                print(f"[handle_create_project] AI Direct notice ({direct_err}), proceeding with default blocks.")

        proj_data = {
            "id": proj_id,
            "title": title,
            "tier": tier,
            "engine": default_engine,
            "default_voice": default_voice,
            "default_settings": defaults if defaults else None,
            "characters": characters,
            "blocks": blocks,
            "master_filename": f"{proj_id}_master.wav"
        }
        user = get_current_user(request)
        if user and user.get("user_id"):
            proj_data["owner_id"] = user["user_id"]
        if folder_id:
            proj_data["folder_id"] = folder_id

        project_mgr.save_project(proj_data, proj_id)
        _recent_created_projects[dedup_key] = (time.time(), proj_data)

        if job_id:
            ACTIVE_JOBS[job_id] = {
                "status": "done",
                "percent": 100,
                "step": "done",
                "message": "Project ready! Opening Studio...",
                "characters": characters,
                "url": f"/studio?project={proj_id}"
            }

        return web.json_response(proj_data)
    except Exception as err:
        import traceback
        traceback.print_exc()
        if job_id:
            ACTIVE_JOBS[job_id] = {
                "status": "error",
                "percent": 0,
                "step": "error",
                "message": f"Project creation error: {err}"
            }
        return web.json_response({"ok": False, "error": f"Failed to create project: {err}"}, status=500)


def hashlib_str(s: str) -> str:
    import hashlib
    return hashlib.md5(s.encode("utf-8")).hexdigest()


async def handle_delete_project(request):
    proj_id = request.match_info["id"]
    success = project_mgr.delete_project(proj_id)
    return web.json_response({"deleted": success, "id": proj_id})


async def handle_get_project(request):
    user = get_current_user(request)
    proj_id = request.query.get("id", "default")
    proj = project_mgr.load_project(proj_id)
    if not proj:
        return web.json_response({"error": "Project not found"}, status=404)
    is_local = request.remote in ("127.0.0.1", "::1", "localhost") or not request.remote
    if user and not user.get("is_admin") and not is_local and proj.get("owner_id") and proj["owner_id"] != user["user_id"]:
        return web.json_response({"error": "Access denied to this project"}, status=403)
    return web.json_response(proj)


async def handle_save_project(request):
    user = get_current_user(request)
    data = await request.json()
    proj_id = data.get("id", "default")
    if user and user.get("user_id") and not data.get("owner_id"):
        data["owner_id"] = user["user_id"]
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


# ---------------- FOLDERS / SERIES COLLECTIONS HANDLERS ---------------- #

async def handle_get_folders(request):
    user = get_current_user(request)
    engine_filter = request.query.get("engine")
    parent_id = request.query.get("parent_id")
    include_all = request.query.get("include_all") == "1"
    is_local = request.remote in ("127.0.0.1", "::1", "localhost") or not request.remote
    owner_id = user["user_id"] if (user and not user.get("is_admin") and not is_local) else None
    folders = project_mgr.list_folders(engine=engine_filter, parent_id=parent_id, include_all=include_all, owner_id=owner_id)
    return web.json_response(folders)

async def handle_get_folder(request):
    user = get_current_user(request)
    folder_id = request.query.get("id", "").strip()
    if not folder_id:
        return web.json_response({"ok": False, "error": "Missing folder id"}, status=400)
    is_local = request.remote in ("127.0.0.1", "::1", "localhost") or not request.remote
    owner_id = user["user_id"] if (user and not user.get("is_admin") and not is_local) else None
    folder = project_mgr.get_folder(folder_id, owner_id=owner_id)
    if not folder:
        return web.json_response({"ok": False, "error": "Folder not found"}, status=404)
    return web.json_response(folder)

async def handle_create_folder(request):
    try:
        user = get_current_user(request)
        owner_id = user["user_id"] if user else None
        data = await request.json()
        title = data.get("title", "").strip()
        if not title:
            return web.json_response({"ok": False, "error": "Title required"}, status=400)
        folder = project_mgr.create_folder(
            title=title,
            author=data.get("author", ""),
            description=data.get("description", ""),
            parent_id=data.get("parent_series_id"),
            cover_image=data.get("cover_image", ""),
            engine=data.get("engine", "fish_s2"),
            series_order=data.get("series_order", 0),
            owner_id=owner_id
        )
        return web.json_response(folder)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

async def handle_delete_folder(request):
    try:
        folder_id = request.match_info.get("id", "").strip()
        delete_chapters = request.query.get("delete_chapters") == "1"
        ok = project_mgr.delete_folder(folder_id, delete_chapters=delete_chapters)
        return web.json_response({"ok": ok})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

async def handle_move_project_to_folder(request):
    try:
        data = await request.json()
        folder_id = data.get("folder_id")
        project_id = data.get("project_id")
        chapter_index = data.get("chapter_index")
        if folder_id:
            ok = project_mgr.add_project_to_folder(folder_id, project_id, chapter_index)
        else:
            ok = project_mgr.remove_project_from_folder(data.get("current_folder_id", ""), project_id)
        return web.json_response({"ok": ok})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

async def handle_reorder_folder_chapters(request):
    try:
        data = await request.json()
        folder_id = data.get("folder_id")
        chapter_ids = data.get("chapter_ids", [])
        ok = project_mgr.reorder_folder_chapters(folder_id, chapter_ids)
        return web.json_response({"ok": ok})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

async def handle_sort_folder_chapters(request):
    try:
        data = await request.json()
        folder_id = data.get("folder_id")
        sorted_ids = project_mgr.sort_folder_chapters(folder_id)
        return web.json_response({"ok": True, "chapter_order": sorted_ids})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

async def handle_get_folder_master_cast(request):
    folder_id = request.query.get("folder_id", "").strip() or request.query.get("id", "").strip()
    cast = project_mgr.get_folder_master_cast(folder_id)
    return web.json_response(cast)

async def handle_update_folder_master_cast(request):
    try:
        data = await request.json()
        folder_id = data.get("folder_id")
        characters = data.get("characters", [])
        sync_to_chapters = data.get("sync_to_chapters", True)
        mode = data.get("mode", "replace")
        ok = project_mgr.update_folder_master_cast(folder_id, characters, sync_to_chapters=sync_to_chapters, mode=mode)
        return web.json_response({"ok": ok})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

async def handle_remove_character_from_master_cast(request):
    try:
        data = await request.json()
        folder_id = data.get("folder_id")
        char_id = data.get("character_id") or data.get("char_id")
        remove_from_chapters = data.get("remove_from_chapters", False)
        ok = project_mgr.remove_character_from_master_cast(folder_id, char_id, remove_from_chapters=remove_from_chapters)
        return web.json_response({"ok": ok})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

async def handle_get_folder_director_settings(request):
    folder_id = request.query.get("folder_id", "").strip() or request.query.get("id", "").strip()
    settings = project_mgr.get_folder_director_settings(folder_id)
    return web.json_response(settings)

async def handle_save_folder_director_settings(request):
    try:
        data = await request.json()
        folder_id = data.get("folder_id")
        settings = data.get("settings", {})
        ok = project_mgr.save_folder_director_settings(folder_id, settings)
        return web.json_response({"ok": ok})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_direct_stub_chapter(request):
    job_id = ""
    try:
        data = await request.json()
        project_id = data.get("project_id", "").strip()
        if not project_id:
            return web.json_response({"ok": False, "error": "Missing project_id"}, status=400)

        job_id = data.get("job_id", "").strip()
        cast_mode = data.get("cast_mode", "multi")
        ai_direct = bool(data.get("ai_direct", True))
        ai_model = data.get("ai_model", "gemini-3.5-flash-lite")
        split_quotes = bool(data.get("split_quotes", True))
        acting_tags = bool(data.get("acting_tags", True))
        acting_intensity = data.get("acting_intensity", "balanced")
        analysis_temperature = float(data.get("analysis_temperature", 0.7))
        default_voice = data.get("default_voice")
        save_as_folder_default = bool(data.get("save_as_folder_default", False))

        if job_id:
            ACTIVE_JOBS[job_id] = {
                "status": "processing",
                "percent": 10,
                "step": "extracting",
                "message": "Extracting chapter manuscript & speech blocks...",
                "characters": []
            }

        def _on_stub_progress(p_data):
            if job_id:
                ACTIVE_JOBS[job_id] = {
                    "status": "done" if p_data.get("percent", 0) >= 100 else "processing",
                    **p_data
                }

        def _direct_sync():
            return project_mgr.direct_stub_chapter(
                project_id=project_id,
                cast_mode=cast_mode,
                ai_direct=ai_direct,
                ai_model=ai_model,
                split_quotes=split_quotes,
                acting_tags=acting_tags,
                acting_intensity=acting_intensity,
                analysis_temperature=analysis_temperature,
                default_voice=default_voice,
                save_as_folder_default=save_as_folder_default,
                progress_callback=_on_stub_progress
            )

        res = await asyncio.to_thread(_direct_sync)
        if job_id:
            ACTIVE_JOBS[job_id] = {
                "status": "done",
                "percent": 100,
                "step": "done",
                "message": f"Chapter directed! {res.get('blocks_count', 0)} speech blocks ready.",
                "characters": res.get("characters", [])
            }
        return web.json_response(res)
    except Exception as e:
        if job_id:
            ACTIVE_JOBS[job_id] = {
                "status": "error",
                "percent": 0,
                "step": "error",
                "message": str(e)
            }
        logger.error(f"[App] Error in handle_direct_stub_chapter: {e}", exc_info=True)
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_epub_generate_series(request):
    try:
        data = await request.json()
        epub_path = data.get("epub_path", "").strip()
        if not epub_path or not os.path.exists(epub_path):
            return web.json_response({"ok": False, "error": "EPUB file not found"}, status=400)

        title = data.get("title")
        author = data.get("author")
        description = data.get("description")
        referer = request.headers.get("Referer", "").lower()
        engine = data.get("engine") or ("kokoro" if "/kokoro" in referer else "fish_s2")
        selected_books = data.get("selected_books")
        selected_chapters = data.get("selected_chapters")

        def _generate_sync():
            return project_mgr.generate_series_from_epub(
                epub_path=epub_path,
                title=title,
                author=author,
                description=description,
                engine=engine,
                selected_book_indices=selected_books,
                selected_chapters=selected_chapters
            )

        res = await asyncio.to_thread(_generate_sync)
        return web.json_response(res)
    except Exception as e:
        logger.error(f"[App] Error in handle_epub_generate_series: {e}", exc_info=True)
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_export_folder(request):
    try:
        data = await request.json()
        folder_id = data.get("folder_id", "").strip()
        if not folder_id:
            return web.json_response({"ok": False, "error": "Missing folder_id"}, status=400)

        folder = project_mgr.get_folder(folder_id)
        if not folder:
            return web.json_response({"ok": False, "error": "Folder not found"}, status=404)

        silence_gap_sec = float(data.get("silence_gap_sec", 2.0))
        chapters_only = bool(data.get("chapters_only", False))

        chapter_ids = folder.get("chapter_ids", [])
        if not chapter_ids:
            return web.json_response({"ok": False, "error": "No chapters in this folder"}, status=400)

        def _export_folder_sync():
            import soundfile as sf
            import numpy as np
            from math import gcd
            from scipy import signal

            def _resample(samples: np.ndarray, orig_sr: int, dest_sr: int) -> np.ndarray:
                if orig_sr == dest_sr or len(samples) == 0:
                    return samples
                g = gcd(int(orig_sr), int(dest_sr))
                up = int(dest_sr // g)
                down = int(orig_sr // g)
                return signal.resample_poly(samples.astype(np.float32), up, down).astype(np.float32)

            target_sr = 44100
            audio_segments = []
            chapters_included = 0

            for pid in chapter_ids:
                proj = project_mgr.get_project(pid)
                if not proj:
                    continue

                if chapters_only:
                    ch_info = ProjectManager.parse_chapter_info(proj.get("title", ""))
                    if ch_info.get("is_front_matter"):
                        continue

                master_path = OUTPUT_DIR / proj.get("master_filename", f"{pid}_master.wav")
                if not master_path.exists():
                    master_path = OUTPUT_DIR / f"{pid}_master.wav"

                ch_audio = None
                ch_sr = target_sr

                if master_path.exists():
                    try:
                        ch_audio, ch_sr = sf.read(str(master_path), dtype="float32")
                    except Exception:
                        ch_audio = None

                if ch_audio is None and proj.get("blocks"):
                    blks = proj.get("blocks", [])
                    b_segs = []
                    for b in blks:
                        if not b.get("is_spoken", True):
                            continue
                        af = b.get("audio_file") or b.get("audio_url")
                        if af:
                            af_name = af.split("/")[-1].split("?")[0]
                            f_path = OUTPUT_DIR / af_name
                            if not f_path.exists():
                                f_path = CACHE_DIR / af_name
                            if f_path.exists():
                                try:
                                    s_data, s_sr = sf.read(str(f_path), dtype="float32")
                                    if s_sr != target_sr:
                                        s_data = _resample(s_data, s_sr, target_sr)
                                    b_segs.append(s_data)
                                    p_after = float(b.get("pause_after", 0.5) or 0.5)
                                    if p_after > 0:
                                        b_segs.append(np.zeros(int(target_sr * p_after), dtype=np.float32))
                                except Exception:
                                    pass
                    if b_segs:
                        ch_audio = np.concatenate(b_segs)
                        ch_sr = target_sr

                if ch_audio is not None and len(ch_audio) > 0:
                    if ch_sr != target_sr:
                        ch_audio = _resample(ch_audio, ch_sr, target_sr)
                    if len(ch_audio.shape) > 1:
                        ch_audio = np.mean(ch_audio, axis=1)
                    audio_segments.append(ch_audio)
                    chapters_included += 1

                    if silence_gap_sec > 0:
                        audio_segments.append(np.zeros(int(target_sr * silence_gap_sec), dtype=np.float32))

            if not audio_segments or chapters_included == 0:
                raise ValueError("No synthesized audio found for chapters in this series. Please render chapters first.")

            if silence_gap_sec > 0 and len(audio_segments) > 1:
                audio_segments.pop()

            master_audio = np.concatenate(audio_segments)
            safe_title = re.sub(r'[^a-zA-Z0-9_\-.]', '_', folder.get("title", "Audiobook_Series"))
            out_filename = f"{safe_title}_Full_Audiobook.wav"
            out_path = OUTPUT_DIR / out_filename
            sf.write(str(out_path), master_audio, target_sr)
            total_duration = round(len(master_audio) / target_sr, 2)

            return {
                "ok": True,
                "audio_url": f"/api/audio/{out_filename}",
                "filename": out_filename,
                "total_chapters": chapters_included,
                "total_duration": total_duration
            }

        res = await asyncio.to_thread(_export_folder_sync)
        return web.json_response(res)
    except Exception as e:
        logger.error(f"[App] Error in handle_export_folder: {e}", exc_info=True)
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_remote_worker_health(request):
    url = request.query.get("url", "").strip()
    if not url:
        return web.json_response({"ok": False, "error": "Missing URL"}, status=400)
    
    import urllib.request
    import json
    for endpoint in [f"{url.rstrip('/')}/v1/health", f"{url.rstrip('/')}/health", f"{url.rstrip('/')}/v1/tts/defaults"]:
        try:
            req = urllib.request.Request(endpoint, headers={"User-Agent": "FishStudio/1.0"})
            with urllib.request.urlopen(req, timeout=4) as response:
                if response.status == 200:
                    try:
                        data = json.loads(response.read().decode("utf-8"))
                        return web.json_response({"ok": True, **data})
                    except Exception:
                        return web.json_response({"ok": True})
        except Exception:
            continue
    return web.json_response({"ok": False, "error": "Could not connect to remote worker endpoint"}, status=502)


async def handle_gpu_local_detect(request):
    force = request.query.get("force") == "1"
    info = local_gpu_mgr.detect_hardware(force_refresh=force)
    return web.json_response(info)


async def handle_gpu_local_status(request):
    return web.json_response(local_gpu_mgr.get_status())


async def handle_gpu_local_start(request):
    data = await request.json() if request.can_read_body else {}
    port = int(data.get("port", 8080))
    engine = data.get("engine", "fish_s2")
    res = local_gpu_mgr.start_worker(engine=engine, port=port)
    return web.json_response(res)


async def handle_gpu_local_stop(request):
    res = local_gpu_mgr.stop_worker()
    return web.json_response(res)



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


async def handle_ai_direct(request):
    """Directs story manuscript using advanced LLM reasoning (Gemini / Groq / OpenAI / Ollama)."""
    try:
        data = await request.json()
        blocks = data.get("blocks", [])
        if not blocks:
            return web.json_response({"ok": False, "error": "No blocks provided to direct."}, status=400)

        provider = (data.get("provider") or "gemini").lower().strip()
        model = data.get("model", "").strip()
        api_key = data.get("api_key", "").strip()
        save_key = bool(data.get("save_key", False))
        split_dialogue = bool(data.get("split_dialogue", True))
        cast_voices = bool(data.get("cast_voices", True))
        add_emotions = bool(data.get("add_emotions", True))
        engine = data.get("engine", "fish_s2")
        default_voice = data.get("default_voice", "")
        job_id = data.get("job_id", "").strip()

        if job_id:
            ACTIVE_JOBS[job_id] = {
                "status": "processing",
                "percent": 8,
                "step": "init",
                "message": "Initializing script blocks...",
                "characters": [],
                "total_blocks": len(blocks),
                "current_chunk": 0,
                "total_chunks": 1
            }

        def _on_ai_progress(p_data):
            if job_id:
                ACTIVE_JOBS[job_id] = {
                    "status": "done" if p_data.get("percent", 0) >= 100 else "processing",
                    **p_data
                }

        cfg = load_config()
        if not api_key:
            api_key = cfg.get(f"{provider}_api_key") or cfg.get("llm_api_key", "")
            if not api_key and provider == "gemini":
                api_key = os.environ.get("GEMINI_API_KEY", "")

        if not api_key and provider != "ollama":
            return web.json_response({
                "ok": False,
                "error": f"Missing API Key for {provider.capitalize()}. Please enter your API Key or save it in settings."
            }, status=400)

        # Retrieve voice library metadata based on engine
        if engine == "kokoro":
            try:
                with open(BASE_DIR / "core" / "voices_metadata.json", "r", encoding="utf-8") as f:
                    k_raw = json.load(f)
                    if isinstance(k_raw, list):
                        voices = k_raw
                    else:
                        voices = [{"id": k, **v} for k, v in k_raw.items()]
            except Exception:
                voices = []
        else:
            try:
                with open(BASE_DIR / "core" / "fish_voices_metadata.json", "r", encoding="utf-8") as f:
                    voices = json.load(f)
            except Exception:
                voices = []

        from core.ai_director import AIDirector
        director = AIDirector()

        def _direct_sync():
            return director.direct_story(
                blocks=blocks,
                voices=voices,
                provider=provider,
                api_key=api_key,
                model=model,
                split_dialogue=split_dialogue,
                cast_voices=cast_voices,
                add_emotions=add_emotions,
                default_narrator_voice=default_voice,
                progress_callback=_on_ai_progress
            )

        res = await asyncio.to_thread(_direct_sync)

        if job_id:
            ACTIVE_JOBS[job_id] = {
                "status": "done",
                "percent": 100,
                "step": "done",
                "message": "Script directing complete!",
                "characters": res.get("characters", []),
                "blocks": res.get("blocks", [])
            }

        if res.get("ok") and save_key and api_key:
            cfg[f"{provider}_api_key"] = api_key
            cfg["default_llm_provider"] = provider
            save_config(cfg)

        return web.json_response(res)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_ai_director_chat(request):
    """
    Handles interactive AI Director Agent conversation.
    Inspects project context and returns agent reply + atomic execution actions.
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid request JSON"}, status=400)

    messages = data.get("messages", [])
    if not messages:
        return web.json_response({"ok": False, "error": "Messages list is required."}, status=400)

    project_context = data.get("project_context", {})
    provider = data.get("provider", "")
    api_key = data.get("api_key", "")
    model = data.get("model", "")
    temperature = float(data.get("temperature", 0.5))

    voices = data.get("available_voices", [])
    if not voices:
        try:
            voices = fish_engine.list_voices()
        except Exception:
            voices = []

    from core.ai_director import AIDirector
    director = AIDirector()

    def _chat_sync():
        return director.agent_chat(
            messages=messages,
            project_context=project_context,
            available_voices=voices,
            provider=provider,
            api_key=api_key,
            model=model,
            temperature=temperature
        )

    res = await asyncio.to_thread(_chat_sync)
    return web.json_response(res)


async def handle_get_ai_director_config(request):
    cfg = load_config()
    def _mask(k):
        if not k:
            return ""
        if len(k) <= 8:
            return "••••••••"
        return f"{k[:4]}••••••••{k[-4:]}"

    return web.json_response({
        "default_provider": cfg.get("default_llm_provider", "gemini"),
        "gemini_has_key": bool(cfg.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")),
        "gemini_masked_key": _mask(cfg.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY", "")),
        "groq_has_key": bool(cfg.get("groq_api_key")),
        "groq_masked_key": _mask(cfg.get("groq_api_key", "")),
        "openai_has_key": bool(cfg.get("openai_api_key")),
        "openai_masked_key": _mask(cfg.get("openai_api_key", ""))
    })


async def handle_save_ai_director_config(request):
    try:
        data = await request.json()
        cfg = load_config()
        if "provider" in data:
            cfg["default_llm_provider"] = data["provider"]
        if "gemini_api_key" in data:
            cfg["gemini_api_key"] = data["gemini_api_key"].strip()
        if "groq_api_key" in data:
            cfg["groq_api_key"] = data["groq_api_key"].strip()
        if "openai_api_key" in data:
            cfg["openai_api_key"] = data["openai_api_key"].strip()
        save_config(cfg)
        return web.json_response({"ok": True, "message": "AI Director settings saved."})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_test_ai_director_key(request):
    try:
        data = await request.json()
        provider = data.get("provider", "gemini")
        api_key = data.get("api_key", "").strip()
        model = data.get("model", "")
        save_key = data.get("save_key", True)

        if not api_key and provider != "ollama":
            cfg = load_config()
            api_key = cfg.get(f"{provider}_api_key") or os.environ.get(f"{provider.upper()}_API_KEY", "")

        if not api_key and provider != "ollama":
            return web.json_response({"ok": False, "error": f"Please enter a valid {provider.capitalize()} API key."}, status=400)

        from core.ai_director import AIDirector
        director = AIDirector()
        res = await asyncio.to_thread(director.test_api_key, provider, api_key, model)

        if res.get("ok") and save_key and api_key:
            cfg = load_config()
            cfg[f"{provider}_api_key"] = api_key
            cfg["default_llm_provider"] = provider
            save_config(cfg)

        return web.json_response(res)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


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
    is_byok = tier_mgr.get_tier() == "byok"
    masked_key = cfg.get("fish_api_key", "") if is_byok else ("sk-••••••••" if (cfg.get("fish_api_key") or tier_mgr.state.get("platform_fish_api_key")) else "")
    return web.json_response({
        "remote_worker_url": remote_url or "",
        "kokoro_remote_worker_url": cfg.get("kokoro_remote_worker_url", ""),
        "fish_remote_worker_url": cfg.get("fish_remote_worker_url", ""),
        "fish_api_key": masked_key,
        "kaggle_username": k_user,
        "kaggle_has_key": k_has_key,
        "active_engine": "kokoro" if is_kokoro else cfg.get("active_engine", "fish_s2"),
        "active": bool(remote_url or (not is_kokoro and (cfg.get("fish_api_key") or tier_mgr.resolve_api_key()))),
        "tier_status": tier_mgr.get_public_status(),
        "google_client_id": cfg.get("google_client_id", "") or os.environ.get("GOOGLE_CLIENT_ID", "")
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
        if res.get("ok"):
            cfg = load_config()
            cfg["kaggle_username"] = username
            cfg["kaggle_key"] = key
            save_config(cfg)
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
    """Fired via navigator.sendBeacon when user closes the browser/tab.
    Note: Remote workers have their own 15-minute inactivity watchdog. We do not
    kill the worker or wipe config on simple page refreshes."""
    return web.Response(text="ok")


def _studio_inactivity_watchdog_loop():
    """Background watchdog: auto-terminate Kaggle GPU only if Studio frontend has been completely inactive for > 20 min."""
    while True:
        time.sleep(30)
        try:
            status = kaggle_mgr.get_status().get("status", "")
            if status in ("ready", "booting", "queued"):
                idle_sec = time.time() - _last_studio_heartbeat[0]
                if idle_sec > 1200:  # 20 minutes without browser heartbeat
                    print(f"\n[KaggleWatchdog] ⚠️ No browser heartbeat for {int(idle_sec)}s (>20m)! Auto-terminating Kaggle GPU to conserve user's quota...")
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
        data = {}
        try:
            data = await request.json()
        except Exception:
            pass

        referer = request.headers.get("Referer", "").lower()
        engine = data.get("engine") or ("kokoro" if "/kokoro" in referer else "")
        target_eng = engine or kaggle_mgr._active_session.get("engine", "fish_s2")

        username = (data.get("username") or cfg.get("kaggle_username", "") or kaggle_mgr._active_session.get("username", "")).strip()
        key = (data.get("key") or cfg.get("kaggle_key", "") or kaggle_mgr._active_session.get("key", "")).strip()
        if not username or not key:
            p = os.path.expanduser("~/.kaggle/kaggle.json")
            if os.path.exists(p):
                try:
                    c = json.load(open(p))
                    username = username or c.get("username", "")
                    key = key or c.get("key", "")
                except Exception:
                    pass

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

    if "fish_api_model" in data:
        m = data.get("fish_api_model", "").strip() or "drama-3"
        cfg["fish_api_model"] = m
        if fish_engine:
            fish_engine.model = m

    if "active_engine" in data:
        engine_choice = data.get("active_engine", "fish_s2").lower()
        cfg["active_engine"] = engine_choice

    save_config(cfg)
    return web.json_response({
        "status": "saved",
        "active_engine": cfg.get("active_engine", "fish_s2"),
        "remote_worker_url": cfg.get("remote_worker_url", ""),
        "active": bool(cfg.get("remote_worker_url") or cfg.get("fish_api_key")),
        "tier_status": tier_mgr.get_public_status(),
        "google_client_id": cfg.get("google_client_id", "") or os.environ.get("GOOGLE_CLIENT_ID", "")
    })


def get_current_user(request: web.Request) -> Dict:
    auth_header = request.headers.get("Authorization", "")
    token = None
    if auth_header.startswith("Bearer "):
        token = auth_header[7:].strip()
    if not token:
        token = request.cookies.get("fish_session")
    if not token:
        token = request.query.get("token")
    return tier_mgr.auth_mgr.get_user_by_session(token)


async def handle_auth_register(request: web.Request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    email = (data.get("email") or "").strip()
    password = (data.get("password") or "").strip()
    name = (data.get("name") or "").strip()

    ok, msg_or_token, user_dict = tier_mgr.auth_mgr.register(email, password, name=name)
    if not ok:
        return web.json_response({"error": msg_or_token}, status=400)

    resp = web.json_response({
        "success": True,
        "token": msg_or_token,
        "user": user_dict
    })
    resp.set_cookie("fish_session", msg_or_token, max_age=30 * 86400, httponly=False, samesite="Lax")
    return resp


async def handle_auth_login(request: web.Request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    email = (data.get("email") or "").strip()
    password = (data.get("password") or "").strip()

    ok, msg_or_token, user_dict = tier_mgr.auth_mgr.login(email, password)
    if not ok:
        return web.json_response({"error": msg_or_token}, status=401)

    resp = web.json_response({
        "success": True,
        "token": msg_or_token,
        "user": user_dict
    })
    resp.set_cookie("fish_session", msg_or_token, max_age=30 * 86400, httponly=False, samesite="Lax")
    return resp


async def handle_auth_google(request: web.Request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    token_str = (data.get("credential") or data.get("token") or "").strip()
    email = (data.get("email") or "").strip()
    name = (data.get("name") or "").strip()
    avatar = (data.get("avatar") or "").strip()
    google_sub = None

    # Real Google ID Token (JWT) sent by Google Identity Services (GSI)
    if token_str:
        try:
            import base64
            parts = token_str.split(".")
            if len(parts) >= 2:
                payload_b64 = parts[1]
                payload_b64 += "=" * ((4 - len(payload_b64) % 4) % 4)
                payload_json = json.loads(base64.urlsafe_b64decode(payload_b64).decode("utf-8"))

                # Check expiration
                exp = payload_json.get("exp", 0)
                if exp and time.time() > exp:
                    return web.json_response({"error": "Google sign-in token has expired. Please sign in again."}, status=400)

                email = payload_json.get("email", email)
                name = payload_json.get("name", name)
                avatar = payload_json.get("picture", avatar)
                google_sub = payload_json.get("sub", "")
        except Exception as e:
            logger.warning(f"Failed decoding google credential: {e}")
            return web.json_response({"error": f"Invalid Google credential: {str(e)}"}, status=400)

    if not email:
        return web.json_response({"error": "Google account email is required"}, status=400)

    ok, msg_or_token, user_dict = tier_mgr.auth_mgr.login_or_register_google(
        email=email,
        name=name,
        google_sub=google_sub,
        avatar=avatar
    )
    if not ok:
        return web.json_response({"error": msg_or_token}, status=400)

    resp = web.json_response({
        "success": True,
        "token": msg_or_token,
        "user": user_dict
    })
    resp.set_cookie("fish_session", msg_or_token, max_age=30 * 86400, httponly=False, samesite="Lax")
    return resp


async def handle_auth_logout(request: web.Request):
    auth_header = request.headers.get("Authorization", "")
    token = None
    if auth_header.startswith("Bearer "):
        token = auth_header[7:].strip()
    if not token:
        token = request.cookies.get("fish_session")
    if token:
        tier_mgr.auth_mgr.logout(token)

    resp = web.json_response({"success": True})
    resp.del_cookie("fish_session")
    return resp


async def handle_auth_me(request: web.Request):
    auth_header = request.headers.get("Authorization", "")
    token = None
    if auth_header.startswith("Bearer "):
        token = auth_header[7:].strip()
    if not token:
        token = request.cookies.get("fish_session")

    user = tier_mgr.auth_mgr.get_user_by_session(token)
    is_logged_in = user is not None
    return web.json_response({
        "logged_in": is_logged_in,
        "user": tier_mgr.auth_mgr.get_public_user(user) if user else None
    })


async def handle_get_tier_status(request):
    user = get_current_user(request)
    return web.json_response(tier_mgr.get_public_status(user=user))


async def handle_set_tier(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    user = get_current_user(request)
    tier = (data.get("tier") or "").strip().lower()
    byok_key = data.get("byok_key")
    if tier:
        tier_mgr.set_tier(tier, byok_key=byok_key, user=user)
        if byok_key is not None and tier == "byok":
            cfg = load_config()
            cfg["fish_api_key"] = byok_key.strip()
            save_config(cfg)
        resolved = tier_mgr.resolve_api_key(user=user)
        if resolved and fish_engine:
            fish_engine.api_key = resolved
    return web.json_response(tier_mgr.get_public_status(user=user))


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

        ch_data = get_chapter_text(epub_path, target_ch_meta["file_path"], chapter_title=target_ch_meta.get("title", ""))

        referer = request.headers.get("Referer", "").lower()
        engine = data.get("engine") or ("kokoro" if "/kokoro" in referer else "fish_s2")
        default_voice = data.get("default_voice") or ("bf_emma" if engine == "kokoro" else "voice_stanley_narrator")

        custom_title = data.get("title") or f"{book['title']} - {target_ch_meta['title']}"

        blocks = project_mgr.split_text_into_blocks(ch_data["text"], default_voice=default_voice)
        for b in blocks:
            b["engine"] = engine

        ai_direct = bool(data.get("ai_direct", False))
        characters = []
        job_id = data.get("job_id", "").strip()

        if job_id:
            ACTIVE_JOBS[job_id] = {
                "status": "processing",
                "percent": 8,
                "step": "extracting",
                "message": "Extracting chapter manuscript & speech blocks...",
                "characters": [],
                "total_blocks": len(blocks),
                "current_chunk": 0,
                "total_chunks": 1
            }

        def _on_epub_progress(p_data):
            if job_id:
                ACTIVE_JOBS[job_id] = {
                    "status": "done" if p_data.get("percent", 0) >= 100 else "processing",
                    **p_data
                }

        if ai_direct and blocks:
            try:
                # Load voices metadata for LLM casting
                if engine == "kokoro":
                    try:
                        with open(BASE_DIR / "core" / "voices_metadata.json", "r", encoding="utf-8") as f:
                            k_raw = json.load(f)
                            voices = k_raw if isinstance(k_raw, list) else [{"id": k, **v} for k, v in k_raw.items()]
                    except Exception:
                        voices = []
                else:
                    try:
                        with open(BASE_DIR / "core" / "fish_voices_metadata.json", "r", encoding="utf-8") as f:
                            voices = json.load(f)
                    except Exception:
                        voices = []

                cfg = load_config()
                provider = data.get("ai_provider") or cfg.get("default_llm_provider", "gemini")
                api_key = data.get("ai_api_key") or cfg.get(f"{provider}_api_key") or os.environ.get(f"{provider.upper()}_API_KEY", "")
                model = data.get("ai_model") or ""

                from core.ai_director import AIDirector
                director = AIDirector()

                def _direct_sync():
                    return director.direct_story(
                        blocks=blocks,
                        voices=voices,
                        provider=provider,
                        api_key=api_key,
                        model=model,
                        split_dialogue=data.get("split_dialogue", True),
                        cast_voices=True,
                        add_emotions=data.get("add_emotions", True),
                        default_narrator_voice=default_voice,
                        progress_callback=_on_epub_progress
                    )

                direct_res = await asyncio.to_thread(_direct_sync)
                if direct_res.get("ok"):
                    blocks = direct_res.get("blocks", blocks)
                    characters = direct_res.get("characters", [])
                    for b in blocks:
                        b["engine"] = engine
            except Exception as direct_err:
                print(f"[handle_epub_import] AI Direct notice ({direct_err}), proceeding with default narrator blocks.")

        proj_id = f"proj_{uuid.uuid4().hex[:8]}"
        proj_url = f"/studio?project={proj_id}"
        proj_data = {
            "id": proj_id,
            "title": custom_title,
            "engine": engine,
            "default_voice": default_voice,
            "characters": characters,
            "blocks": blocks,
            "created_at": time.time(),
            "updated_at": time.time(),
            "master_filename": f"{proj_id}_master.wav"
        }
        project_mgr.save_project(proj_data, proj_id)

        if job_id:
            ACTIVE_JOBS[job_id] = {
                "status": "done",
                "percent": 100,
                "step": "done",
                "message": "Audiobook chapter ready! Opening Studio...",
                "characters": characters,
                "url": proj_url
            }

        return web.json_response({
            "ok": True,
            "id": proj_id,
            "title": custom_title,
            "blocks_count": len(blocks),
            "word_count": ch_data["word_count"],
            "estimated_minutes": ch_data["estimated_minutes"],
            "url": proj_url
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
            "error": "Remote worker offline or tunnel expired",
            "url": test_url
        }, status=200)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e), "url": test_url}, status=200)


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
    app.router.add_get("/login", handle_index)
    app.router.add_get("/studio", handle_index)
    app.router.add_get("/studio/", handle_index)
    app.router.add_get("/projects", handle_index)
    app.router.add_get("/favicon.ico", handle_favicon)
    app.router.add_get("/studio/favicon.svg", handle_favicon)

    # Voices & Reference management
    app.router.add_get("/api/engines", handle_get_engines)
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
    app.router.add_post("/api/project/cache_audio", handle_cache_client_audio)
    app.router.add_post("/api/check_cache", handle_check_cache)
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

    # Folders & Series Collections
    app.router.add_get("/api/folders", handle_get_folders)
    app.router.add_post("/api/folders/new", handle_create_folder)
    app.router.add_delete("/api/folders/{id}", handle_delete_folder)
    app.router.add_get("/api/folder", handle_get_folder)
    app.router.add_post("/api/folder/move_project", handle_move_project_to_folder)
    app.router.add_post("/api/folder/reorder", handle_reorder_folder_chapters)
    app.router.add_post("/api/folder/sort_chapters", handle_sort_folder_chapters)
    app.router.add_get("/api/folder/master_cast", handle_get_folder_master_cast)
    app.router.add_post("/api/folder/master_cast", handle_update_folder_master_cast)
    app.router.add_post("/api/folder/master_cast/remove_character", handle_remove_character_from_master_cast)
    app.router.add_get("/api/folder/director_settings", handle_get_folder_director_settings)
    app.router.add_post("/api/folder/director_settings", handle_save_folder_director_settings)
    app.router.add_post("/api/folder/export", handle_export_folder)

    # Text & Auto-directing
    app.router.add_post("/api/split_text", handle_split_text)
    app.router.add_post("/api/auto_direct", handle_auto_direct)
    app.router.add_post("/api/ai_director/direct", handle_ai_direct)
    app.router.add_post("/api/ai_director/chat", handle_ai_director_chat)
    app.router.add_get("/api/ai_director/config", handle_get_ai_director_config)
    app.router.add_post("/api/ai_director/config", handle_save_ai_director_config)
    app.router.add_post("/api/ai_director/test_key", handle_test_ai_director_key)
    app.router.add_get("/api/job_progress", handle_job_progress)
    app.router.add_post("/api/merge_short", handle_merge_short)

    # User Accounts & Auth
    app.router.add_post("/api/auth/register", handle_auth_register)
    app.router.add_post("/api/auth/login", handle_auth_login)
    app.router.add_post("/api/auth/google", handle_auth_google)
    app.router.add_post("/api/auth/logout", handle_auth_logout)
    app.router.add_get("/api/auth/me", handle_auth_me)

    # Audio & Config
    app.router.add_get("/api/audio/{filename}", handle_get_audio)
    app.router.add_get("/api/config", handle_get_config)
    app.router.add_post("/api/config", handle_save_config)
    app.router.add_get("/api/tier/status", handle_get_tier_status)
    app.router.add_post("/api/tier/set", handle_set_tier)
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

    # EPUB Audiobook Importer & Chapter Stubs
    app.router.add_post("/api/epub/inspect", handle_epub_inspect)
    app.router.add_post("/api/epub/import", handle_epub_import)
    app.router.add_post("/api/epub/generate_series", handle_epub_generate_series)
    app.router.add_post("/api/chapter/direct_stub", handle_direct_stub_chapter)

    # Local GPU & Remote Worker
    app.router.add_get("/api/gpu/local/detect", handle_gpu_local_detect)
    app.router.add_get("/api/gpu/local/status", handle_gpu_local_status)
    app.router.add_post("/api/gpu/local/start", handle_gpu_local_start)
    app.router.add_post("/api/gpu/local/stop", handle_gpu_local_stop)
    app.router.add_get("/api/remote_worker/health", handle_remote_worker_health)

    # Static assets
    app.router.add_static("/studio", STUDIO_DIR)
    app.router.add_static("/voices", BASE_DIR / "voices")

    # Deprecated Kokoro routes redirect to unified Studio
    app.router.add_get("/kokoro", handle_kokoro_index)
    app.router.add_get("/kokoro/", handle_kokoro_index)
    app.router.add_get("/kokoro/studio", handle_kokoro_index)
    app.router.add_get("/kokoro/studio/", handle_kokoro_index)
    app.router.add_get("/kokoro/favicon.svg", handle_kokoro_favicon)

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
