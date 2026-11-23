import os
import re
import io
import json
import time
import base64
import hashlib
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union
import numpy as np
import soundfile as sf
import urllib.request
import urllib.error

from core.audio_dsp import process_audio_fx
from core.project_manager import ProjectManager

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

    def __init__(self, remote_url: Optional[str] = None, api_key: Optional[str] = None, model: str = "drama-3"):
        self.remote_url = remote_url.strip() if (remote_url and remote_url.strip()) else None
        self.api_key = api_key.strip() if (api_key and api_key.strip()) else None
        self.model = model.strip() if (model and model.strip()) else "drama-3"
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

        # 1. Check if voice_id points to a preset archetype or installed library voice
        if voice_id and voice_id not in self.preset_voices:
            self.load_preset_voices()

        if voice_id and voice_id in self.preset_voices:
            preset = self.preset_voices[voice_id]
            preset_ref = preset.get("reference_audio")
            # If reference_audio is empty OR belongs to a different voice (stale leftover from previous cast assignment), use this preset's ref
            if not reference_audio or (preset_ref and Path(reference_audio).name != Path(preset_ref).name):
                reference_audio = preset_ref
                ref_text = preset.get("reference_text")
            elif not ref_text and preset.get("reference_text"):
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

    PARALINGUISTIC_ACTIONS = {
        "chuckle": "chuckle",
        "chuckles": "chuckle",
        "sigh": "sigh",
        "sighs": "sigh",
        "gasp": "gasp",
        "gasps": "gasp",
        "gasping": "gasp",
        "laugh": "laughs",
        "laughs": "laughs",
        "laughter": "laughs",
        "groan": "groan",
        "groans": "groan",
        "pant": "pant",
        "pants": "pant",
        "panting": "pant",
        "snicker": "snicker",
        "snickers": "snicker",
        "snort": "snort",
        "snorts": "snort",
        "cough": "cough",
        "coughs": "cough",
        "yawn": "yawn",
        "yawns": "yawn",
        "cry": "crying",
        "crying": "crying",
        "sob": "sobbing",
        "sobbing": "sobbing",
        "inhale": "inhale",
        "exhale": "exhale",
        "throat-clearing": "throat-clearing",
        "yell": "screaming",
        "yelling": "screaming",
        "scream": "screaming",
        "screaming": "screaming",
        "shout": "screaming",
        "shouting": "screaming"
    }

    @classmethod
    def decompose_emotion_tag(cls, tag: str) -> str:
        """
        Parses and standardizes emotion tags, separating physical paralinguistic actions
        (chuckle, sigh, gasp, laugh, sob, etc.) from delivery/mood descriptors (sarcastic, whisper, angry).
        Produces tightly bound discrete tokens like [chuckle][sarcastic] without stray spaces,
        allowing Fish Speech S2 Pro's neural codebook to fire both the physical acoustic sound
        and the semantic acting tone.
        """
        if not tag:
            return ""
        raw = tag.strip()
        if not raw:
            return ""

        bracket_matches = re.findall(r'\[([^\]]+)\]', raw)
        if bracket_matches:
            tokens = []
            for b in bracket_matches:
                items = [p.strip() for p in re.split(r'[,;/]+', b) if p.strip()]
                tokens.extend(items)
        else:
            tokens = [p.strip() for p in re.split(r'[,;/]+', raw) if p.strip()]

        if not tokens:
            return ""

        action_tokens = []
        mood_tokens = []

        for item in tokens:
            item_clean = item.strip().lower()
            if item_clean in cls.PARALINGUISTIC_ACTIONS:
                canonical = cls.PARALINGUISTIC_ACTIONS[item_clean]
                token_str = f"[{canonical}]"
                if token_str not in action_tokens:
                    action_tokens.append(token_str)
            else:
                if item not in mood_tokens:
                    mood_tokens.append(item)

        result_parts = []
        if action_tokens:
            result_parts.extend(action_tokens)
        if mood_tokens:
            for m in mood_tokens:
                result_parts.append(f"[{m}]")

        return "".join(result_parts)

    @classmethod
    def split_action_and_mood_tags(cls, tag: str) -> Tuple[str, str]:
        """
        Splits emotion tags into:
        (1) full_tag: all action and mood tags combined, e.g. [sigh][uncanny realization]
        (2) mood_only_tag: continuous delivery/mood styles with one-shot physical actions
            (sigh, gasp, chuckle, laugh, groan, cough, yawn, etc.) stripped out, e.g. [uncanny realization].
        This ensures that when an oversized block is chunked, physical sounds (like sighing) only play
        at the beginning of the sentence instead of repeating in every subsequent sub-chunk.
        """
        if not tag:
            return "", ""
        raw = tag.strip()
        bracket_matches = re.findall(r'\[([^\]]+)\]', raw)
        tokens = []
        if bracket_matches:
            for b in bracket_matches:
                items = [p.strip() for p in re.split(r'[,;/]+', b) if p.strip()]
                tokens.extend(items)
        else:
            tokens = [p.strip() for p in re.split(r'[,;/]+', raw) if p.strip()]

        action_tokens = []
        mood_tokens = []
        for item in tokens:
            item_clean = item.strip().lower()
            if item_clean in cls.PARALINGUISTIC_ACTIONS:
                canonical = cls.PARALINGUISTIC_ACTIONS[item_clean]
                action_tokens.append(f"[{canonical}]")
            else:
                mood_tokens.append(f"[{item}]")

        full_tag = "".join(action_tokens + mood_tokens)
        mood_only_tag = "".join(mood_tokens)
        return full_tag, mood_only_tag

    def format_emotion_text(self, text: str, emotion_tag: Optional[str]) -> str:
        """Embeds natural-language emotion tags into the prompt with proper token spacing for Drama 3 / S2."""
        clean = text.strip() if text else ""
        if not clean:
            return ""

        # 1. Check if text already starts with one or more bracketed tags, e.g.:
        #    [chuckle][sarcastic]“Why not own the ladder?” or [chuckle][sarcastic] Why not...
        m_inline = re.match(r'^\s*((?:\[[^\]]+\]\s*)*\[[^\]]+\])(\s*)(.*)$', clean, re.DOTALL)
        if m_inline:
            inline_tags_str = m_inline.group(1).strip()
            rest_text = m_inline.group(3).strip()
            effective_tag = emotion_tag.strip() if (emotion_tag and emotion_tag.strip()) else inline_tags_str
            tag = self.decompose_emotion_tag(effective_tag)
            result = f"{tag} {rest_text}" if rest_text else tag
        elif emotion_tag and emotion_tag.strip():
            tag = self.decompose_emotion_tag(emotion_tag.strip())
            result = f"{tag} {clean}" if tag else clean
        else:
            result = clean

        # Ensure any inline tags stuck directly to words (e.g. "[sigh]Your") have a space: "[sigh] Your"
        result = re.sub(r'\]([A-Za-z0-9"\'\u00C0-\u024F])', r'] \1', result)
        return result

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
        fx_filter: str,
        model: Optional[str] = None
    ) -> str:
        """Computes deterministic MD5 hash for audio caching."""
        ref_sig = "noref"
        if ref_audio_path and ref_audio_path.exists():
            try:
                stat = ref_audio_path.stat()
                ref_sig = f"{ref_audio_path.name}_{stat.st_size}_{stat.st_mtime}"
            except Exception:
                ref_sig = ref_audio_path.name

        norm_model = "s2.1-pro" if model in ("s2_pro", "s2-pro", "s2.1-pro") else ("drama-3" if model in ("drama3", "drama-3") else (getattr(self, "model", "drama-3") or "drama-3"))
        cache_str = (
            f"fish_{norm_model}__{formatted_text}__{ref_sig}__{ref_text or ''}__"
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
        model: Optional[str] = None,
        **kwargs
    ) -> Dict:
        """
        Synthesizes a single text block using Fish Audio S2 Pro.
        Caches result to disk.
        """
        clean_text = text.strip()
        if not clean_text:
            return {"error": "Empty text"}

        # Validate voice_id: if foreign voice from Kokoro or Edge, reset to None for default fallback
        if voice_id and ("Neural" in str(voice_id) or str(voice_id).startswith(("am_", "af_", "bm_", "bf_"))):
            voice_id = None

        model_name = "s2.1-pro" if model in ("s2_pro", "s2-pro", "s2.1-pro") else ("drama-3" if model in ("drama3", "drama-3") else (getattr(self, "model", "drama-3") or "drama-3"))

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
            gain_f, pitch_shift_f, warmth_f, clarity_f, reverb_f, fx_filter_s,
            model=model_name
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

        # Check raw neural audio cache for instant DSP re-sculpting (<0.1s)
        raw_cache_hash = self.compute_cache_hash(
            formatted_text, ref_path, ref_text, 1.0, temp_f, top_p_f,
            1.0, 0.0, 0.0, 0.0, 0.0, "none",
            model=model_name
        )
        raw_cache_file = CACHE_DIR / f"raw_{raw_cache_hash}.wav"

        if not force_refresh and raw_cache_file.exists():
            try:
                base_samples, sr = sf.read(str(raw_cache_file))
                processed = base_samples * gain_f if gain_f != 1.0 else base_samples.copy()
                processed = process_audio_fx(
                    processed,
                    sr=sr,
                    pitch_shift_st=pitch_shift_f,
                    warmth_db=warmth_f,
                    clarity_db=clarity_f,
                    reverb_wet=reverb_f,
                    speed=speed_f,
                    fx_filter=fx_filter_s
                )
                sf.write(str(cache_file), processed, sr)
                try:
                    raw_hash_path = CACHE_DIR / f"raw_{cache_hash}.wav"
                    if not raw_hash_path.exists():
                        import shutil
                        shutil.copyfile(str(raw_cache_file), str(raw_hash_path))
                except Exception:
                    pass
                duration = len(processed) / sr
                return {
                    "hash": cache_hash,
                    "audio_url": f"/api/audio/{cache_hash}.wav",
                    "duration": round(duration, 2),
                    "cached": False,
                    "engine": "fish_s2",
                    "instant_sculpt": True
                }
            except Exception as e:
                print(f"[FishEngine] Instant DSP sculpt fallback ({e})")

        base_cache_hash = cache_hash
        # When force_refresh is requested, delete previous cached files for this exact text/tag/voice signature
        # and generate a fresh unique take hash so the browser receives a brand new file path
        if force_refresh:
            prev_files = [
                CACHE_DIR / f"{base_cache_hash}.wav",
                CACHE_DIR / f"raw_{base_cache_hash}.wav",
                CACHE_DIR / f"raw_{raw_cache_hash}.wav"
            ] + list(CACHE_DIR.glob(f"{base_cache_hash}_*.wav")) \
              + list(CACHE_DIR.glob(f"raw_{base_cache_hash}_*.wav")) \
              + list(CACHE_DIR.glob(f"raw_{raw_cache_hash}_*.wav")) \
              + list(CACHE_DIR.glob(f"dsp_{base_cache_hash}*.wav"))
            for p in prev_files:
                try:
                    if p.exists():
                        p.unlink()
                except Exception as del_err:
                    print(f"[FishEngine] Could not delete previous cache file {p.name}: {del_err}")

            import uuid
            take_id = uuid.uuid4().hex[:8]
            cache_hash = f"{base_cache_hash}_{take_id}"
            cache_file = CACHE_DIR / f"{cache_hash}.wav"

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
                    formatted_text, ref_path, ref_text, speed_f, temp_f, top_p_f, voice_id, model=model_name
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
            import io
            samples, sr = sf.read(io.BytesIO(audio_bytes))

            # Save raw untouched neural voice for instant non-destructive DSP re-sculpting
            raw_hash_file = CACHE_DIR / f"raw_{cache_hash}.wav"
            try:
                with open(raw_hash_file, "wb") as f_raw:
                    f_raw.write(audio_bytes)
            except Exception:
                pass
            # Update baseline neutral cache if not force_refresh
            if not force_refresh and raw_cache_file != raw_hash_file:
                try:
                    with open(raw_cache_file, "wb") as f_raw:
                        f_raw.write(audio_bytes)
                except Exception:
                    pass

            # Apply DSP transformations if non-neutral
            needs_dsp = (
                gain_f != 1.0 or abs(speed_f - 1.0) >= 0.03 or pitch_shift_f != 0.0 or warmth_f != 0.0 or
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
                    speed=speed_f,
                    fx_filter=fx_filter_s
                )
                sf.write(str(cache_file), processed, sr)
                if force_refresh:
                    try:
                        sf.write(str(CACHE_DIR / f"{base_cache_hash}.wav"), processed, sr)
                    except Exception:
                        pass
                duration = len(processed) / sr
            else:
                with open(cache_file, "wb") as f:
                    f.write(audio_bytes)
                if force_refresh:
                    try:
                        with open(CACHE_DIR / f"{base_cache_hash}.wav", "wb") as f_base:
                            f_base.write(audio_bytes)
                    except Exception:
                        pass
                duration = len(samples) / sr

            return {
                "hash": cache_hash,
                "audio_url": f"/api/audio/{cache_hash}.wav?t={int(time.time() * 1000)}",
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
        """
        Sends inference request to Colab T4 / Local GPU worker.
        Auto-chunks blocks exceeding safe GPU VRAM limits (>450 chars) into sub-chunks,
        preventing CUDA out-of-memory errors on Tesla T4 GPUs while avoiding tiny micro-fragments.
        """
        clean_text = text.strip()
        # Clean decorative leading formatting punctuation (e.g. "— ", "--- ", "* ") that can cause Dual-AR model hallucination
        stripped = re.sub(r'^[—–\-\*\#\~\=\s]+', '', clean_text)
        if re.search(r'[A-Za-z0-9]', stripped):
            clean_text = stripped

        # Extract leading emotion/acting tag if present so it propagates cleanly across sub-chunks
        tag_prefix = ""
        m_tag = re.match(r'^((?:\[[^\]]+\]\s*)+)', clean_text)
        if m_tag:
            tag_prefix = self.decompose_emotion_tag(m_tag.group(1).strip())

        # If text is oversized (>130 chars), break into safe clauses (120 chars max)
        # to protect Tesla T4 GPU VRAM and prevent CUDA Out Of Memory during DAC decoding
        if len(clean_text) > 130:
            chunks = ProjectManager.split_into_sentences(clean_text, max_chars=120)
            valid_chunks = [c.strip() for c in chunks if re.search(r'[A-Za-z0-9]', c.strip())]
            if len(valid_chunks) > 1:
                print(f"[FishEngine] Auto-chunking oversized block ({len(clean_text)} chars) into {len(valid_chunks)} GPU-safe clauses (180 chars max)...")
                combined_audio_parts = []
                sample_rate = 24000
                full_tag, mood_only_tag = self.split_action_and_mood_tags(tag_prefix)

                for c_idx, sub_c in enumerate(valid_chunks):
                    sub_c_clean = sub_c.strip()
                    if not sub_c_clean:
                        continue
                    # First chunk gets full tags (including physical actions like [sigh]);
                    # subsequent chunks only get continuous tone/mood tags (like [terrified]), preventing repetitive physical sounds
                    if not sub_c_clean.startswith("["):
                        effective_sub_tag = full_tag if c_idx == 0 else mood_only_tag
                        if effective_sub_tag:
                            sub_c_clean = f"{effective_sub_tag}{sub_c_clean}"

                    part_bytes = self._call_remote_worker_single(
                        sub_c_clean, ref_path, ref_text, speed, temperature, top_p
                    )
                    part_samples, sr = sf.read(io.BytesIO(part_bytes))
                    sample_rate = sr
                    combined_audio_parts.append(part_samples)
                    # Natural 40ms trailing gap between clauses
                    if c_idx < len(valid_chunks) - 1:
                        gap_len = int(sr * 0.04)
                        combined_audio_parts.append(np.zeros(gap_len, dtype=part_samples.dtype))

                if combined_audio_parts:
                    final_samples = np.concatenate(combined_audio_parts)
                    buf = io.BytesIO()
                    sf.write(buf, final_samples, sample_rate, format="WAV")
                    return buf.getvalue()

        return self._call_remote_worker_single(clean_text, ref_path, ref_text, speed, temperature, top_p)

    def _call_remote_worker_single(
        self,
        text: str,
        ref_path: Optional[Path],
        ref_text: Optional[str],
        speed: float,
        temperature: float,
        top_p: float
    ) -> bytes:
        """Sends a single inference request to the remote GPU worker."""
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
                payload["prompt_audio"] = payload["references"][0]["audio"]
                payload["prompt_text"] = ref_text or ""

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
                with urllib.request.urlopen(req, timeout=120) as resp:
                    audio_data = resp.read()
                    if audio_data and len(audio_data) > 200:
                        return audio_data
            except urllib.error.HTTPError as e:
                last_exc = e
                if e.code == 404:
                    continue
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
        voice_id: Optional[str],
        model: Optional[str] = None
    ) -> bytes:
        """Sends inference request to official Fish Audio REST API."""
        api_endpoint = "https://api.fish.audio/v1/tts"
        model_name = "s2.1-pro" if model in ("s2_pro", "s2-pro", "s2.1-pro") else ("drama-3" if model in ("drama3", "drama-3") else (getattr(self, "model", "drama-3") or "drama-3"))

        payload = {
            "text": text,
            "format": "wav",
            "temperature": temperature,
            "top_p": top_p,
            "model": model_name
        }
        if speed and speed != 1.0:
            payload["prosody"] = {"speed": speed}

        # If voice_id is a Fish Audio model ID (e.g., 32-char hex or fish_<hex>), pass reference_id directly
        clean_voice_id = (voice_id or "").strip()
        if clean_voice_id.startswith("fish_"):
            clean_voice_id = clean_voice_id[5:]

        is_hex_model = len(clean_voice_id) == 32 and all(c in "0123456789abcdefABCDEF" for c in clean_voice_id)

        content_type = "application/json"
        request_data = None

        if is_hex_model:
            payload["reference_id"] = clean_voice_id
            request_data = json.dumps(payload).encode("utf-8")
        elif ref_path and ref_path.exists():
            # For custom zero-shot voices, Fish Audio Cloud API requires 16-bit mono WAV binary bytes sent via MessagePack
            try:
                import soundfile as sf
                import io
                data, sr = sf.read(str(ref_path))
                if data.ndim > 1:
                    data = data.mean(axis=1)  # convert stereo to mono
                buf = io.BytesIO()
                sf.write(buf, data, sr, format="WAV", subtype="PCM_16")
                raw_wav_bytes = buf.getvalue()

                payload["references"] = [
                    {
                        "audio": raw_wav_bytes,
                        "text": ref_text or ""
                    }
                ]
                import msgpack
                request_data = msgpack.packb(payload)
                content_type = "application/msgpack"
            except Exception as e:
                print(f"[FishEngine] MessagePack preparation notice: {e}, falling back to base64 JSON")
                with open(ref_path, "rb") as f:
                    b64 = base64.b64encode(f.read()).decode("utf-8")
                    payload["references"] = [{"audio": b64, "text": ref_text or ""}]
                request_data = json.dumps(payload).encode("utf-8")
        elif clean_voice_id:
            payload["reference_id"] = clean_voice_id
            request_data = json.dumps(payload).encode("utf-8")
        else:
            request_data = json.dumps(payload).encode("utf-8")

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": content_type,
            "User-Agent": "FishSpeechStudio/1.0",
            "model": model_name
        }

        req = urllib.request.Request(
            api_endpoint,
            data=request_data,
            headers=headers
        )

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                audio_data = resp.read()
                if audio_data and len(audio_data) > 100:
                    return audio_data
                raise ValueError("Cloud API returned empty audio response")
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            print(f"[FishEngine] Cloud API HTTP {e.code} error: {err_body}")
            if model_name == "drama-3" and e.code in (400, 404, 500, 503):
                print("[FishEngine] Falling back to s2.1-pro...")
                fallback_headers = dict(headers)
                fallback_headers["model"] = "s2.1-pro"
                if isinstance(request_data, bytes) and content_type == "application/json":
                    payload["model"] = "s2.1-pro"
                    fb_data = json.dumps(payload).encode("utf-8")
                else:
                    fb_data = request_data
                fb_req = urllib.request.Request(api_endpoint, data=fb_data, headers=fallback_headers)
                with urllib.request.urlopen(fb_req, timeout=60) as fb_resp:
                    fb_audio = fb_resp.read()
                    if fb_audio and len(fb_audio) > 100:
                        return fb_audio
            raise
