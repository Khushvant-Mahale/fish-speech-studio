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

ELEVENLABS_VOICES = [
    {
        "id": "21m00Tcm4TlvDq8ikWAM",
        "name": "Rachel (Calm & Professional)",
        "engine": "elevenlabs",
        "engine_label": "ElevenLabs (v4/Flash)",
        "gender": "Female",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "RA",
        "color": "#8b5cf6",
        "description": "Calm, natural, narrative young female voice"
    },
    {
        "id": "pNInz6obpgDQGcFmaJgB",
        "name": "Adam (Deep Narrator)",
        "engine": "elevenlabs",
        "engine_label": "ElevenLabs (v4/Flash)",
        "gender": "Male",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "AD",
        "color": "#3b82f6",
        "description": "Deep, resonant, classic audiobook narrator"
    },
    {
        "id": "ErXwobaYiN019PkySvjV",
        "name": "Antoni (Dramatic & Well-Rounded)",
        "engine": "elevenlabs",
        "engine_label": "ElevenLabs (v4/Flash)",
        "gender": "Male",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "AN",
        "color": "#6366f1",
        "description": "Warm, confident male protagonist"
    },
    {
        "id": "EXAVITQu4vr4xnSDxMaL",
        "name": "Bella (Expressive & Emotive)",
        "engine": "elevenlabs",
        "engine_label": "ElevenLabs (v4/Flash)",
        "gender": "Female",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "BE",
        "color": "#ec4899",
        "description": "Bright, emotive, high dynamic acting"
    },
    {
        "id": "VR6AewLTigWG4xSOukaG",
        "name": "Arnold (Gravelly & Ominous)",
        "engine": "elevenlabs",
        "engine_label": "ElevenLabs (v4/Flash)",
        "gender": "Male",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "AR",
        "color": "#e11d48",
        "description": "Deep, weathered, gritty thriller antagonist"
    },
    {
        "id": "AZnzlk1XvdvUeBnXmlld",
        "name": "Domi (Fierce & Strong)",
        "engine": "elevenlabs",
        "engine_label": "ElevenLabs (v4/Flash)",
        "gender": "Female",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "DO",
        "color": "#f59e0b",
        "description": "Sharp, commanding female character"
    },
    {
        "id": "TxGEqnHWrfWFTfGW9XjX",
        "name": "Josh (Warm & Intimate)",
        "engine": "elevenlabs",
        "engine_label": "ElevenLabs (v4/Flash)",
        "gender": "Male",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "JO",
        "color": "#10b981",
        "description": "Friendly, approachable, modern voice"
    },
    {
        "id": "MF3mGyEYCl7XYWbV9V6O",
        "name": "Elli (Youthful & Innocent)",
        "engine": "elevenlabs",
        "engine_label": "ElevenLabs (v4/Flash)",
        "gender": "Female",
        "accent": "American",
        "flag": "🇺🇸",
        "badge": "EL",
        "color": "#06b6d4",
        "description": "Young, clear, innocent dialogue actor"
    }
]


class ElevenLabsEngine:
    """
    ElevenLabs Premier Commercial Engine Adapter.
    Supports v4 / v3 Multilingual, Eleven Flash v2.5, and Turbo v2.5 models.
    """

    def __init__(self):
        self.sample_rate = 44100
        self.voices = ELEVENLABS_VOICES

    def get_voices(self) -> List[Dict[str, Any]]:
        return self.voices

    def _clean_text_for_speech(self, text: str) -> str:
        # Strip stage tags like [whisper], [scream]
        clean = re.sub(r'\[.*?\]', '', text)
        clean = re.sub(r'\s+', ' ', clean).strip()
        return clean

    def _get_api_key(self) -> str:
        return (
            os.environ.get("ELEVENLABS_API_KEY")
            or os.environ.get("ELEVEN_API_KEY")
            or ""
        ).strip()

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
        model_id: str = "eleven_flash_v2_5",
        force_refresh: bool = False,
        **kwargs
    ) -> Dict[str, Any]:
        raw_m = kwargs.get("model") or model_id
        if raw_m in ("v4", "v4_cinematic", "v4-cinematic"):
            model_id = "eleven_multilingual_v2"
        elif raw_m in ("v3", "eleven_multilingual_v1"):
            model_id = "eleven_multilingual_v1"
        elif raw_m in ("flash", "flash_v2.5", "eleven_flash_v2_5"):
            model_id = "eleven_flash_v2_5"
        elif raw_m:
            model_id = str(raw_m)

        clean_text = self._clean_text_for_speech(text)
        if not clean_text:
            return {"error": "Text cannot be empty"}

        target_voice_id = voice_id or "21m00Tcm4TlvDq8ikWAM"
        # Match by name if id passed was voice name
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
            f"eleven::{clean_text}::{target_voice_id}::{model_id}::{speed}::{gain}::"
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
                    "engine": "elevenlabs"
                }
            except Exception:
                pass

        api_key = self._get_api_key()
        if not api_key:
            return {
                "error": "ElevenLabs API Key not configured. Please add ELEVENLABS_API_KEY to your environment or Settings."
            }

        url = f"https://api.elevenlabs.io/v1/text-to-speech/{target_voice_id}"
        payload = {
            "text": clean_text,
            "model_id": model_id,
            "voice_settings": {
                "stability": 0.50,
                "similarity_boost": 0.75,
                "style": 0.0,
                "use_speaker_boost": True
            }
        }

        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "xi-api-key": api_key,
                "Accept": "audio/mpeg"
            },
            method="POST"
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                mp3_bytes = resp.read()
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            return {"error": f"ElevenLabs API Error ({e.code}): {err_body}"}
        except Exception as e:
            return {"error": f"ElevenLabs network error: {e}"}

        # Decode MP3 to numpy float32
        raw_samples, sr = sf.read(io.BytesIO(mp3_bytes), dtype="float32")
        if raw_samples.ndim > 1:
            raw_samples = np.mean(raw_samples, axis=1)

        # Apply gain
        if abs(gain - 1.0) > 0.01:
            samples_to_process = raw_samples * float(gain)
        else:
            samples_to_process = raw_samples.copy()

        # Apply DSP effects if non-neutral
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
            "engine": "elevenlabs"
        }
