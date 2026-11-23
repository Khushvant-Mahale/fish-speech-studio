import asyncio
import hashlib
import io
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import edge_tts
import numpy as np
import soundfile as sf
from core.audio_dsp import process_audio_fx

BASE_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = BASE_DIR / "cache"
VOICES_FILE = BASE_DIR / "core" / "edge_voices_metadata.json"

CACHE_DIR.mkdir(parents=True, exist_ok=True)


class EdgeTTSEngine:
    """
    Microsoft Edge TTS Engine Adapter.
    Provides 300+ high-quality neural voices in 80+ languages with zero GPU cost and zero API keys.
    """

    def __init__(self):
        self.sample_rate = 24000
        self.voices_cache: List[Dict[str, Any]] = []
        self._load_cached_voices()

    def _load_cached_voices(self):
        if VOICES_FILE.exists():
            try:
                with open(VOICES_FILE, "r", encoding="utf-8") as f:
                    self.voices_cache = json.load(f)
            except Exception as e:
                print(f"[EdgeTTSEngine] Error loading voice cache: {e}")
                self.voices_cache = []

    async def fetch_and_cache_voices(self) -> List[Dict[str, Any]]:
        """Fetch all available voices from Edge TTS and save to local metadata cache."""
        try:
            raw_voices = await edge_tts.list_voices()
            formatted = []
            for v in raw_voices:
                short_name = v.get("ShortName", "")
                friendly = v.get("FriendlyName", short_name)
                # Clean up friendly name
                display_name = (
                    friendly.replace("Microsoft ", "")
                    .replace(" Online (Natural) - ", " (")
                    .replace(" Online (Natural)", "")
                )
                if not display_name.endswith(")"):
                    display_name += f" ({v.get('Locale', '')})"

                locale = v.get("Locale", "en-US")
                lang = locale.split("-")[0]
                gender = v.get("Gender", "Neutral")

                # Suggest roles based on name/voice style
                suggested_role = "Narrator" if "Guy" in short_name or "Christopher" in short_name or "Brian" in short_name else "Dialogue"

                formatted.append({
                    "id": short_name,
                    "name": display_name,
                    "engine": "edge_tts",
                    "gender": gender,
                    "locale": locale,
                    "lang": lang,
                    "suggested_role": suggested_role,
                    "sample_rate": 24000
                })

            formatted.sort(key=lambda x: (0 if x["locale"].startswith("en-") else 1, x["locale"], x["name"]))
            self.voices_cache = formatted

            try:
                with open(VOICES_FILE, "w", encoding="utf-8") as f:
                    json.dump(formatted, f, indent=2)
            except Exception as e:
                print(f"[EdgeTTSEngine] Failed saving voice cache to disk: {e}")

            return self.voices_cache
        except Exception as e:
            print(f"[EdgeTTSEngine] Failed to fetch voices: {e}")
            return self.voices_cache

    def get_voices(self, locale: Optional[str] = None) -> List[Dict[str, Any]]:
        if not self.voices_cache:
            # Sync fetch if cache empty
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    # Running loop: cannot run_until_complete; return fallback
                    pass
                else:
                    loop.run_until_complete(self.fetch_and_cache_voices())
            except Exception:
                pass

        if not self.voices_cache:
            # Minimal hardcoded fallback if network is offline
            return [
                {"id": "en-US-GuyNeural", "name": "Guy (en-US)", "engine": "edge_tts", "gender": "Male", "locale": "en-US", "lang": "en", "suggested_role": "Narrator"},
                {"id": "en-US-JennyNeural", "name": "Jenny (en-US)", "engine": "edge_tts", "gender": "Female", "locale": "en-US", "lang": "en", "suggested_role": "Dialogue"},
                {"id": "en-US-AriaNeural", "name": "Aria (en-US)", "engine": "edge_tts", "gender": "Female", "locale": "en-US", "lang": "en", "suggested_role": "Dialogue"},
                {"id": "en-GB-RyanNeural", "name": "Ryan (en-GB)", "engine": "edge_tts", "gender": "Male", "locale": "en-GB", "lang": "en", "suggested_role": "Dialogue"},
                {"id": "en-GB-SoniaNeural", "name": "Sonia (en-GB)", "engine": "edge_tts", "gender": "Female", "locale": "en-GB", "lang": "en", "suggested_role": "Dialogue"}
            ]

        if locale:
            return [v for v in self.voices_cache if v.get("locale", "").lower() == locale.lower() or v.get("lang", "").lower() == locale.lower()]
        return self.voices_cache

    async def _async_generate_audio(self, text: str, voice_id: str, rate_str: str, pitch_str: str) -> bytes:
        """Call Edge TTS async stream and accumulate MP3 bytes."""
        comm = edge_tts.Communicate(text, voice=voice_id, rate=rate_str, pitch=pitch_str)
        buf = bytearray()
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                buf.extend(chunk["data"])
        return bytes(buf)

    def synthesize_block(
        self,
        text: str,
        voice_id: str = "en-US-GuyNeural",
        speed: float = 1.0,
        pitch_shift: float = 0.0,
        gain: float = 1.0,
        warmth: float = 0.0,
        clarity: float = 0.0,
        reverb: float = 0.0,
        radio_fx: bool = False,
        fx_filter: str = "none",
        force_refresh: bool = False
    ) -> Dict[str, Any]:
        """
        Synthesize text using Microsoft Edge TTS with optional audio DSP effects.
        """
        clean_text = text.strip()
        if not clean_text:
            return {"error": "Empty text"}

        # Validate voice_id: if empty or a foreign voice from Fish/Kokoro, fallback to standard Edge neural voice
        valid_voice = (voice_id or "").strip()
        known_ids = {v["id"] for v in self.voices_cache} if self.voices_cache else set()
        if not valid_voice or "Neural" not in valid_voice or (known_ids and valid_voice not in known_ids):
            valid_voice = "en-US-GuyNeural"
        voice_id = valid_voice

        # Format rate and pitch for edge-tts
        speed_pct = int(round((speed - 1.0) * 100))
        rate_str = f"{speed_pct:+d}%"

        pitch_hz = int(round(pitch_shift * 5))
        pitch_str = f"{pitch_hz:+d}Hz"

        # Unique hash for cached output
        fx_filter_s = str(fx_filter or ("radio" if radio_fx else "none")).strip().lower()
        pitch_shift_f = float(pitch_shift)
        warmth_f = float(warmth)
        clarity_f = float(clarity)
        reverb_f = float(reverb)

        cache_key = (
            f"edge::{clean_text}::{voice_id}::{rate_str}::{pitch_str}::{gain}::"
            f"{pitch_shift_f}::{warmth_f}::{clarity_f}::{reverb_f}::{radio_fx}::{fx_filter_s}"
        )
        cache_hash = hashlib.md5(cache_key.encode("utf-8")).hexdigest()
        cache_file = CACHE_DIR / f"{cache_hash}.wav"

        # Check existing cache
        if not force_refresh and cache_file.exists():
            try:
                info = sf.info(str(cache_file))
                return {
                    "hash": cache_hash,
                    "audio_url": f"/api/audio/{cache_hash}.wav",
                    "duration": round(info.duration, 2),
                    "cached": True,
                    "sample_rate": info.samplerate,
                    "engine": "edge_tts"
                }
            except Exception:
                pass

        # Synthesize from Edge TTS API
        try:
            # Run async stream in a thread/loop safely
            try:
                loop = asyncio.get_event_loop()
            except RuntimeError:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)

            if loop.is_running():
                # We are inside an active event loop: run in a separate worker thread
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor() as executor:
                    mp3_bytes = executor.submit(
                        asyncio.run,
                        self._async_generate_audio(clean_text, voice_id, rate_str, pitch_str)
                    ).result()
            else:
                mp3_bytes = loop.run_until_complete(
                    self._async_generate_audio(clean_text, voice_id, rate_str, pitch_str)
                )

            if not mp3_bytes:
                return {"error": "Edge TTS returned empty audio"}

            # Decode MP3 to numpy float32
            raw_samples, sr = sf.read(io.BytesIO(mp3_bytes), dtype="float32")
            if raw_samples.ndim > 1:
                raw_samples = np.mean(raw_samples, axis=1)

            # Cache raw neural speech before DSP
            raw_cache_file = CACHE_DIR / f"raw_{cache_hash}.wav"
            try:
                sf.write(str(raw_cache_file), raw_samples, sr)
            except Exception:
                pass

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
                    speed=1.0,
                    fx_filter=fx_filter_s
                )
            else:
                final_samples = samples_to_process

            # Save processed WAV to cache
            sf.write(str(cache_file), final_samples, sr)
            duration = len(final_samples) / sr

            return {
                "hash": cache_hash,
                "audio_url": f"/api/audio/{cache_hash}.wav",
                "duration": round(duration, 2),
                "cached": False,
                "sample_rate": sr,
                "engine": "edge_tts"
            }

        except Exception as e:
            print(f"[EdgeTTSEngine] Synthesis failed: {e}")
            return {"error": f"Edge TTS error: {str(e)}"}
