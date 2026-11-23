import hashlib
import io
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional
import urllib.request
import urllib.error

import numpy as np
import soundfile as sf
from core.audio_dsp import process_audio_fx

BASE_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = BASE_DIR / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

CARTESIA_VOICES = [
    {
        "id": "a0e99841-438c-4a64-b679-ae501e7d6091",
        "name": "Barbershop Man (Warm & Deep)",
        "engine": "cartesia",
        "engine_label": "Cartesia Sonic (3.6/4)",
        "gender": "Male",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "BM",
        "color": "#f59e0b",
        "description": "Ultra low latency, resonant warm storyteller"
    },
    {
        "id": "79a125e8-cd45-4c13-8a67-188112f4dd22",
        "name": "Commercial Lady (Crisp & Polished)",
        "engine": "cartesia",
        "engine_label": "Cartesia Sonic (3.6/4)",
        "gender": "Female",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "CL",
        "color": "#ec4899",
        "description": "Clear, professional commercial and educational voice"
    },
    {
        "id": "829ccd10-f8b3-43cd-b8a0-4aeaa81f3b30",
        "name": "British Storyteller (Dramatic)",
        "engine": "cartesia",
        "engine_label": "Cartesia Sonic (3.6/4)",
        "gender": "Male",
        "accent": "British",
        "flag": "🇬🇧",
        "badge": "BS",
        "color": "#8b5cf6",
        "description": "Sophisticated fantasy and gothic novel narrator"
    },
    {
        "id": "694f9389-aac1-45b6-b726-9d9369183238",
        "name": "News Anchor (Authoritative)",
        "engine": "cartesia",
        "engine_label": "Cartesia Sonic (3.6/4)",
        "gender": "Female",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "NA",
        "color": "#3b82f6",
        "description": "Formal, commanding, perfectly paced"
    },
    {
        "id": "b7d50908-b17c-442d-ad8d-810c63997ed9",
        "name": "Midnight Host (Intimate & Smooth)",
        "engine": "cartesia",
        "engine_label": "Cartesia Sonic (3.6/4)",
        "gender": "Male",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "MH",
        "color": "#10b981",
        "description": "Late-night radio host, smooth velvet timbre"
    }
]


class CartesiaEngine:
    """
    Cartesia Sonic Engine Adapter (Sonic 3.6 / Sonic 4).
    Provides lightning-fast commercial neural speech with dynamic speed and pitch controls.
    """

    def __init__(self):
        self.sample_rate = 44100
        self.voices = CARTESIA_VOICES

    def get_voices(self) -> List[Dict[str, Any]]:
        return self.voices

    def _clean_text_for_speech(self, text: str) -> str:
        clean = re.sub(r'\[.*?\]', '', text)
        clean = re.sub(r'\s+', ' ', clean).strip()
        return clean

    def _get_api_key(self) -> str:
        return (os.environ.get("CARTESIA_API_KEY") or "").strip()

    def synthesize_block(
        self,
        text: str,
        voice_id: Optional[str] = None,
        speed: float = 1.0,
        gain: float = 1.0,
        pitch_shift: float = 0.0,
        warmth: float = 0.0,
        clarity: float = 0.0,
        reverb: float = 0.0,
        radio_fx: bool = False,
        fx_filter: str = "none",
        model_id: str = "sonic-english",
        force_refresh: bool = False,
        **kwargs
    ) -> Dict[str, Any]:
        clean_text = self._clean_text_for_speech(text)
        if not clean_text:
            return {"error": "Text cannot be empty"}

        target_voice_id = voice_id or "a0e99841-438c-4a64-b679-ae501e7d6091"
        for v in self.voices:
            if v["name"].lower() == target_voice_id.lower() or v["id"] == target_voice_id:
                target_voice_id = v["id"]
                break

        pitch_shift_f = float(pitch_shift or 0.0)
        warmth_f = float(warmth or 0.0)
        clarity_f = float(clarity or 0.0)
        reverb_f = float(reverb or 0.0)
        fx_filter_s = str(fx_filter or ("radio" if radio_fx else "none")).strip().lower()

        cache_key = (
            f"cartesia::{clean_text}::{target_voice_id}::{model_id}::{speed}::{gain}::"
            f"{pitch_shift_f}::{warmth_f}::{clarity_f}::{reverb_f}::{radio_fx}::{fx_filter_s}"
        )
        cache_hash = hashlib.md5(cache_key.encode("utf-8")).hexdigest()
        cache_file = CACHE_DIR / f"{cache_hash}.wav"

        if not force_refresh and cache_file.exists():
            try:
                info = sf.info(str(cache_file))
                return {
                    "hash": cache_hash,
                    "audio_url": f"/api/audio/{cache_hash}.wav",
                    "duration": round(info.duration, 2),
                    "cached": True,
                    "sample_rate": info.samplerate,
                    "engine": "cartesia"
                }
            except Exception:
                pass

        api_key = self._get_api_key()
        if not api_key:
            return {
                "error": "Cartesia API Key not configured. Please add CARTESIA_API_KEY to your environment or Settings."
            }

        url = "https://api.cartesia.ai/tts/bytes"
        payload = {
            "model_id": model_id,
            "transcript": clean_text,
            "voice": {
                "mode": "id",
                "id": target_voice_id
            },
            "output_format": {
                "container": "wav",
                "sample_rate": self.sample_rate,
                "encoding": "pcm_s16le"
            }
        }

        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-API-Key": api_key,
                "Cartesia-Version": "2024-06-10"
            },
            method="POST"
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                wav_bytes = resp.read()
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            return {"error": f"Cartesia API Error ({e.code}): {err_body}"}
        except Exception as e:
            return {"error": f"Cartesia network error: {e}"}

        raw_samples, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32")
        if raw_samples.ndim > 1:
            raw_samples = np.mean(raw_samples, axis=1)

        if abs(gain - 1.0) > 0.01:
            samples_to_process = raw_samples * float(gain)
        else:
            samples_to_process = raw_samples.copy()

        is_neutral = (
            abs(pitch_shift_f) < 0.01
            and abs(warmth_f) < 0.1
            and abs(clarity_f) < 0.1
            and reverb_f < 0.01
            and fx_filter_s == "none"
        )

        if not is_neutral:
            final_samples = process_audio_fx(
                samples_to_process,
                sr=sr,
                pitch_shift_st=pitch_shift_f,
                warmth_db=warmth_f,
                clarity_db=clarity_f,
                reverb_wet=reverb_f,
                radio_fx=radio_fx,
                fx_filter=fx_filter_s
            )
        else:
            final_samples = samples_to_process

        sf.write(str(cache_file), final_samples, sr)
        duration = float(len(final_samples)) / float(sr)

        return {
            "hash": cache_hash,
            "audio_url": f"/api/audio/{cache_hash}.wav",
            "duration": round(duration, 2),
            "cached": False,
            "sample_rate": sr,
            "engine": "cartesia"
        }
