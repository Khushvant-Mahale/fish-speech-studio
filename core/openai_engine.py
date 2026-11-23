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

OPENAI_VOICES = [
    {
        "id": "alloy",
        "name": "Alloy (Neutral & Balanced)",
        "engine": "openai",
        "engine_label": "OpenAI (4o-mini/tts-1)",
        "gender": "Neutral",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "AL",
        "color": "#10b981",
        "description": "Clean, balanced, general-purpose voice"
    },
    {
        "id": "echo",
        "name": "Echo (Warm & Grounded)",
        "engine": "openai",
        "engine_label": "OpenAI (4o-mini/tts-1)",
        "gender": "Male",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "EC",
        "color": "#3b82f6",
        "description": "Smooth, resonant male voice"
    },
    {
        "id": "fable",
        "name": "Fable (Expressive & British)",
        "engine": "openai",
        "engine_label": "OpenAI (4o-mini/tts-1)",
        "gender": "Neutral",
        "accent": "British",
        "flag": "🇬🇧",
        "badge": "FA",
        "color": "#8b5cf6",
        "description": "Dynamic, whimsical storytelling narration"
    },
    {
        "id": "onyx",
        "name": "Onyx (Deep & Authoritative)",
        "engine": "openai",
        "engine_label": "OpenAI (4o-mini/tts-1)",
        "gender": "Male",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "ON",
        "color": "#1f2937",
        "description": "Deep, commanding baritone for serious narration"
    },
    {
        "id": "nova",
        "name": "Nova (Energetic & Friendly)",
        "engine": "openai",
        "engine_label": "OpenAI (4o-mini/tts-1)",
        "gender": "Female",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "NO",
        "color": "#ec4899",
        "description": "Bright, energetic, warm conversational voice"
    },
    {
        "id": "shimmer",
        "name": "Shimmer (Clear & Emotional)",
        "engine": "openai",
        "engine_label": "OpenAI (4o-mini/tts-1)",
        "gender": "Female",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "SH",
        "color": "#06b6d4",
        "description": "Soft, expressive female acting voice"
    }
]


class OpenAIEngine:
    """
    OpenAI Audio Speech Adapter (gpt-4o-mini-tts, tts-1, tts-1-hd).
    Provides world-class natural neural audio.
    """

    def __init__(self):
        self.sample_rate = 24000
        self.voices = OPENAI_VOICES

    def get_voices(self) -> List[Dict[str, Any]]:
        return self.voices

    def _clean_text_for_speech(self, text: str) -> str:
        clean = re.sub(r'\[.*?\]', '', text)
        clean = re.sub(r'\s+', ' ', clean).strip()
        return clean

    def _get_api_key(self) -> str:
        return (os.environ.get("OPENAI_API_KEY") or "").strip()

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
        model_id: str = "tts-1",
        force_refresh: bool = False,
        **kwargs
    ) -> Dict[str, Any]:
        raw_m = kwargs.get("model") or model_id
        if raw_m in ("tts-1", "tts-1-hd"):
            model_id = str(raw_m)
        elif raw_m in ("gpt-4o-mini-tts", "gpt-4o", "gpt-4o-mini"):
            model_id = "gpt-4o-mini-tts"
        elif raw_m:
            model_id = str(raw_m)

        clean_text = self._clean_text_for_speech(text)
        if not clean_text:
            return {"error": "Text cannot be empty"}

        target_voice_id = (voice_id or "alloy").lower().strip()
        valid_voice_ids = [v["id"] for v in self.voices]
        if target_voice_id not in valid_voice_ids:
            # Check by name prefix
            for v in self.voices:
                if v["name"].lower().startswith(target_voice_id):
                    target_voice_id = v["id"]
                    break
            else:
                target_voice_id = "alloy"

        pitch_shift_f = float(pitch_shift or 0.0)
        warmth_f = float(warmth or 0.0)
        clarity_f = float(clarity or 0.0)
        reverb_f = float(reverb or 0.0)
        fx_filter_s = str(fx_filter or ("radio" if radio_fx else "none")).strip().lower()

        speed_clamped = max(0.25, min(4.0, float(speed or 1.0)))

        cache_key = (
            f"openai::{clean_text}::{target_voice_id}::{model_id}::{speed_clamped}::{gain}::"
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
                    "engine": "openai"
                }
            except Exception:
                pass

        api_key = self._get_api_key()
        if not api_key:
            return {
                "error": "OpenAI API Key not configured. Please add OPENAI_API_KEY to your environment or Settings."
            }

        url = "https://api.openai.com/v1/audio/speech"
        payload = {
            "model": model_id if model_id in ("tts-1", "tts-1-hd") else "tts-1",
            "input": clean_text,
            "voice": target_voice_id,
            "response_format": "mp3",
            "speed": speed_clamped
        }

        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}"
            },
            method="POST"
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                mp3_bytes = resp.read()
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            return {"error": f"OpenAI API Error ({e.code}): {err_body}"}
        except Exception as e:
            return {"error": f"OpenAI network error: {e}"}

        raw_samples, sr = sf.read(io.BytesIO(mp3_bytes), dtype="float32")
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
            "engine": "openai"
        }
