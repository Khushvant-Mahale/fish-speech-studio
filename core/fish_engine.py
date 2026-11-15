import os
import re
import json
import base64
import hashlib
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union
import numpy as np
import soundfile as sf
import urllib.request
import urllib.error

from core.audio_dsp import process_audio_fx

BASE_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = BASE_DIR / "cache"
OUTPUT_DIR = BASE_DIR / "output"
VOICES_DIR = BASE_DIR / "voices" / "reference"
FISH_VOICES_FILE = BASE_DIR / "core" / "fish_voices_metadata.json"

CACHE_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
VOICES_DIR.mkdir(parents=True, exist_ok=True)


class FishEngine:
    """
    Inference and voice cloning engine for Fish Audio S2 Pro (Fish Speech).
    Supports:
      1. Zero-shot voice cloning with local audio reference clips + transcripts.
      2. 15,000+ natural language inline emotion tags ([whisper], [scream], [panicked]).
      3. Remote GPU worker (Google Colab / Local GPU via Cloudflare tunnel).
      4. Official Fish Audio Cloud API (api.fish.audio).
      5. Automatic disk caching by content & voice hash.
    """

    def __init__(self, remote_url: Optional[str] = None, api_key: Optional[str] = None):
        self.remote_url = remote_url.strip() if (remote_url and remote_url.strip()) else None
        self.api_key = api_key.strip() if (api_key and api_key.strip()) else None
        self.sample_rate = 24000  # Default synthesis sample rate
        self.preset_voices: Dict[str, Dict] = {}
        self.load_preset_voices()

    def load_preset_voices(self):
        """Loads default horror, thriller, and cinematic voice archetypes."""
        if FISH_VOICES_FILE.exists():
            try:
                with open(FISH_VOICES_FILE, "r", encoding="utf-8") as f:
                    voices = json.load(f)
                    for v in voices:
                        self.preset_voices[v["id"]] = v
            except Exception as e:
                print(f"[FishEngine] Warning loading preset voices: {e}")

    def resolve_reference_audio(
        self,
        reference_audio: Optional[str],
        reference_text: Optional[str],
        voice_id: Optional[str]
    ) -> Tuple[Optional[Path], Optional[str]]:
        """Resolves reference audio file path and transcript, checking presets if voice_id is given."""
        ref_path: Optional[Path] = None
        ref_text: Optional[str] = reference_text

        # 1. Check if voice_id points to a preset archetype
        if voice_id and voice_id in self.preset_voices:
            preset = self.preset_voices[voice_id]
            if not reference_audio and preset.get("reference_audio"):
                p = BASE_DIR / preset["reference_audio"]
                if p.exists():
                    ref_path = p
            if not ref_text and preset.get("reference_text"):
                ref_text = preset["reference_text"]

        # 2. Check explicit reference_audio parameter
        if reference_audio:
            p = Path(reference_audio)
            if not p.is_absolute():
                candidates = [
                    BASE_DIR / reference_audio,
                    VOICES_DIR / reference_audio,
                    BASE_DIR / "voices" / reference_audio
                ]
                for c in candidates:
                    if c.exists():
                        ref_path = c
                        break
                if not ref_path:
                    ref_path = p
            else:
                ref_path = p

        return ref_path, ref_text

    def format_emotion_text(self, text: str, emotion_tag: Optional[str]) -> str:
        """Embeds natural-language emotion tags (e.g. [whispering in fear]) cleanly into the prompt."""
        clean = text.strip()
        if not clean:
            return ""

        if not emotion_tag:
            return clean

        tag = emotion_tag.strip()
        if not (tag.startswith("[") and tag.endswith("]")):
            tag = f"[{tag}]"

        # Check if text already begins with the exact tag or a similar bracketed tag
        if clean.startswith("[") and "]" in clean:
            return clean

        return f"{tag} {clean}"

    def compute_cache_hash(
        self,
        formatted_text: str,
        ref_audio_path: Optional[Path],
        ref_text: Optional[str],
        speed: float,
        temperature: float,
        top_p: float,
        gain: float,
        pitch_shift: float,
        warmth: float,
        clarity: float,
        reverb: float,
        fx_filter: str
    ) -> str:
        """Computes deterministic MD5 hash for audio caching."""
        ref_sig = "noref"
        if ref_audio_path and ref_audio_path.exists():
            try:
                stat = ref_audio_path.stat()
                ref_sig = f"{ref_audio_path.name}_{stat.st_size}_{stat.st_mtime}"
            except Exception:
                ref_sig = ref_audio_path.name

        cache_str = (
            f"fish_s2__{formatted_text}__{ref_sig}__{ref_text or ''}__"
            f"{speed:.2f}__{temperature:.2f}__{top_p:.2f}__{gain:.2f}__"
            f"{pitch_shift:.1f}__{warmth:.1f}__{clarity:.1f}__{reverb:.2f}__{fx_filter}"
        )
        return hashlib.md5(cache_str.encode("utf-8")).hexdigest()

    def synthesize_block(
        self,
        text: str,
        voice_id: Optional[str] = None,
        reference_audio: Optional[str] = None,
        reference_text: Optional[str] = None,
        emotion_tag: Optional[str] = None,
        speed: float = 1.0,
        gain: float = 1.0,
        temperature: float = 0.7,
        top_p: float = 0.85,
        pitch_shift: float = 0.0,
        warmth: float = 0.0,
        clarity: float = 0.0,
        reverb: float = 0.0,
        radio_fx: bool = False,
        fx_filter: str = "none",
        force_refresh: bool = False,
        prev_audio: Optional[str] = None,
        prev_text: Optional[str] = None,
        enable_rolling_context: bool = True,
        **kwargs
    ) -> Dict:
        """
        Synthesizes a single text block using Fish Audio S2 Pro.
        Caches result to disk.
        """
        clean_text = text.strip()
        if not clean_text:
            return {"error": "Empty text"}

        # Format emotion prompt
        formatted_text = self.format_emotion_text(clean_text, emotion_tag)

        # Resolve reference voice audio and transcript
        ref_path, ref_text = self.resolve_reference_audio(reference_audio, reference_text, voice_id)

        # Prepare parameters
        speed_f = float(speed or 1.0)
        gain_f = float(gain or 1.0)
        temp_f = float(temperature if temperature is not None else 0.7)
        top_p_f = float(top_p if top_p is not None else 0.85)
        pitch_shift_f = float(pitch_shift or 0.0)
        warmth_f = float(warmth or 0.0)
        clarity_f = float(clarity or 0.0)
        reverb_f = float(reverb or 0.0)
        fx_filter_s = str(fx_filter or ("radio" if radio_fx else "none")).strip().lower()

        # Cache check
        cache_hash = self.compute_cache_hash(
            formatted_text, ref_path, ref_text, speed_f, temp_f, top_p_f,
            gain_f, pitch_shift_f, warmth_f, clarity_f, reverb_f, fx_filter_s
        )
        cache_file = CACHE_DIR / f"{cache_hash}.wav"

        if not force_refresh and cache_file.exists():
            try:
                data, sr = sf.read(str(cache_file))
                duration = len(data) / sr
                return {
                    "hash": cache_hash,
                    "audio_url": f"/api/audio/{cache_hash}.wav",
                    "duration": round(duration, 2),
                    "cached": True,
                    "engine": "fish_s2"
                }
            except Exception:
                pass

        audio_bytes: Optional[bytes] = None
        source_tag = "remote_worker"
        last_error = None

        # ---------------- 1. Remote GPU Worker (Google Colab / Local GPU) ----------------
        if self.remote_url:
            try:
                audio_bytes = self._call_remote_worker(
                    formatted_text, ref_path, ref_text, speed_f, temp_f, top_p_f
                )
                source_tag = "cloud_gpu_fish"
            except Exception as e:
                err_str = str(e)
                print(f"[FishEngine] Remote GPU worker failed: {err_str}")
                if "502" in err_str or "504" in err_str or "refused" in err_str.lower() or "not found" in err_str.lower():
                    last_error = "Cloud GPU Worker is offline or tunnel disconnected (HTTP 502). Click 🚀 Cloud GPU in the top bar to launch a fresh Tesla T4 session."
                else:
                    last_error = f"Cloud GPU worker ({self.remote_url}) error: {err_str}"
                audio_bytes = None

        # ---------------- 2. Fish Audio Cloud API ----------------
        if not audio_bytes and self.api_key:
            try:
                audio_bytes = self._call_cloud_api(
                    formatted_text, ref_path, ref_text, speed_f, temp_f, top_p_f, voice_id
                )
                source_tag = "fish_cloud_api"
            except urllib.error.HTTPError as e:
                if e.code == 402:
                    last_error = (
                        "Fish Audio Cloud API returned 402 (Payment Required). "
                        "Your API key is authenticated, but your account balance is $0.00. "
                        "Please top up credits on fish.audio or launch the free 1-Click Colab T4 GPU Worker!"
                    )
                elif e.code == 401:
                    last_error = "Fish Audio API Key is invalid or expired (401 Unauthorized)."
                else:
                    last_error = f"Fish Audio Cloud API error (HTTP {e.code}): {e.reason}"
                print(f"[FishEngine] Fish Audio Cloud API error: {last_error}")
                audio_bytes = None
            except Exception as e:
                print(f"[FishEngine] Fish Audio Cloud API failed: {e}")
                last_error = f"Fish Audio API connection error: {e}"
                audio_bytes = None

        # ---------------- 3. No Worker or API Connected ----------------
        if not audio_bytes:
            return {
                "error": last_error or (
                    "Fish Audio S2 Pro requires an active Google Colab GPU worker or a Fish Audio API Key. "
                    "Click ⚙️ Cloud GPU in the top bar to connect your Colab tunnel, or configure your API key in Settings."
                ),
                "engine": "fish_s2",
                "needs_worker": True
            }

        # ---------------- 4. Post-Process DSP & Write WAV ----------------
        try:
            # Temporary file to inspect sample rate and samples
            temp_path = CACHE_DIR / f"temp_{cache_hash}.wav"
            with open(temp_path, "wb") as f:
                f.write(audio_bytes)

            samples, sr = sf.read(str(temp_path))
            temp_path.unlink(missing_ok=True)

            # Apply DSP transformations if non-neutral
            needs_dsp = (
                gain_f != 1.0 or pitch_shift_f != 0.0 or warmth_f != 0.0 or
                clarity_f != 0.0 or reverb_f != 0.0 or fx_filter_s != "none"
            )

            if needs_dsp:
                processed = samples * gain_f if gain_f != 1.0 else samples.copy()
                processed = process_audio_fx(
                    processed,
                    sr=sr,
                    pitch_shift_st=pitch_shift_f,
                    warmth_db=warmth_f,
                    clarity_db=clarity_f,
                    reverb_wet=reverb_f,
                    fx_filter=fx_filter_s
                )
                sf.write(str(cache_file), processed, sr)
                duration = len(processed) / sr
            else:
                with open(cache_file, "wb") as f:
                    f.write(audio_bytes)
                duration = len(samples) / sr

            return {
                "hash": cache_hash,
                "audio_url": f"/api/audio/{cache_hash}.wav",
                "duration": round(duration, 2),
                "cached": False,
                "engine": "fish_s2",
                "accelerated_by": source_tag
            }

        except Exception as e:
            return {"error": f"Failed to decode Fish Audio output: {e}"}

    def _call_remote_worker(
        self,
        text: str,
        ref_path: Optional[Path],
        ref_text: Optional[str],
        speed: float,
        temperature: float,
        top_p: float
    ) -> bytes:
        """Sends inference request to Colab T4 / Local GPU worker."""
        # 1. Build standard Fish Speech REST payload
        payload = {
            "text": text,
            "format": "wav",
            "temperature": temperature,
            "top_p": top_p
        }

        if ref_path and ref_path.exists():
            with open(ref_path, "rb") as f:
                payload["references"] = [
                    {
                        "audio": base64.b64encode(f.read()).decode("utf-8"),
                        "text": ref_text or ""
                    }
                ]
                # Also include legacy fields for backwards compatibility
                payload["prompt_audio"] = payload["references"][0]["audio"]
                payload["prompt_text"] = ref_text or ""

        # Try native Fish Speech /v1/tts endpoint first, fallback to /synthesize
        endpoints = [
            f"{self.remote_url.rstrip('/')}/v1/tts",
            f"{self.remote_url.rstrip('/')}/synthesize"
        ]

        last_exc = None
        for ep in endpoints:
            try:
                req = urllib.request.Request(
                    ep,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "User-Agent": "FishSpeechStudio/1.0"
                    }
                )
                with urllib.request.urlopen(req, timeout=50) as resp:
                    audio_data = resp.read()
                    if audio_data and len(audio_data) > 200:
                        return audio_data
            except urllib.error.HTTPError as e:
                last_exc = e
                if e.code == 404:
                    continue  # Try alternate endpoint
                raise
            except Exception as e:
                last_exc = e
                continue

        if last_exc:
            raise last_exc
        raise ValueError("Remote GPU worker returned empty audio response")

    def _call_cloud_api(
        self,
        text: str,
        ref_path: Optional[Path],
        ref_text: Optional[str],
        speed: float,
        temperature: float,
        top_p: float,
        voice_id: Optional[str]
    ) -> bytes:
        """Sends inference request to official Fish Audio REST API."""
        api_endpoint = "https://api.fish.audio/v1/tts"

        payload = {
            "text": text,
            "format": "wav",
            "temperature": temperature,
            "top_p": top_p
        }

        if ref_path and ref_path.exists():
            with open(ref_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
                payload["references"] = [
                    {
                        "audio": b64,
                        "text": ref_text or ""
                    }
                ]
        elif voice_id and not voice_id.startswith("fish_"):
            payload["reference_id"] = voice_id

        req = urllib.request.Request(
            api_endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "User-Agent": "FishSpeechStudio/1.0"
            }
        )

        with urllib.request.urlopen(req, timeout=45) as resp:
            audio_data = resp.read()
            if audio_data and len(audio_data) > 100:
                return audio_data
            raise ValueError("Cloud API returned empty audio response")
