"""
Neural Voice Designer for Fish Speech Studio
=============================================
Synthesizes custom zero-shot voice reference timbres purely from natural-language text prompts.
Works via:
1. Local Voice Forge (Kokoro Multi-Voice Vector Blending + Parametric DSP Shaping) - 100% Free & Offline.
2. Fish Audio Cloud Voice Design (if API key is present).
"""

import os
import re
import json
import hashlib
from pathlib import Path
from typing import Dict, Optional, Tuple, Any

import numpy as np
import soundfile as sf

BASE_DIR = Path(__file__).resolve().parent.parent
VOICES_DIR = BASE_DIR / "voices" / "reference"
FISH_VOICES_FILE = BASE_DIR / "core" / "fish_voices_metadata.json"
VOICES_DIR.mkdir(parents=True, exist_ok=True)


class VoiceDesigner:
    """Analyzes text prompts and synthesizes distinct zero-shot reference voice assets."""

    def __init__(self, kokoro_engine=None):
        self.kokoro_engine = kokoro_engine

    def _ensure_kokoro(self):
        if not self.kokoro_engine:
            from core.kokoro_engine import KokoroEngine
            self.kokoro_engine = KokoroEngine()
        return self.kokoro_engine

    def parse_voice_prompt(self, prompt: str) -> Dict[str, Any]:
        """Parses natural-language descriptions into acoustic synthesis parameters."""
        p = prompt.lower().strip()

        # 1. Gender detection
        is_female = any(w in p for w in [
            "female", "woman", "girl", "lady", "heroine", "witch", "queen",
            "mother", "daughter", "sister", "maiden", "anime girl", "she", "her"
        ])
        is_monster = any(w in p for w in [
            "monster", "demon", "creature", "beast", "shadow", "alien", "ghoul", "void"
        ])

        # 2. Accent detection
        is_british = any(w in p for w in ["british", "uk", "english", "victorian", "gothic", "cockney", "london"])

        # 3. Age / Texture / Pitch
        is_elderly = any(w in p for w in ["elderly", "old", "ancient", "grandfather", "grandmother", "veteran", "aged"])
        is_young = any(w in p for w in ["young", "teen", "teenager", "boy", "kid", "youth", "child"])
        is_deep = any(w in p for w in ["deep", "baritone", "bass", "low", "gravelly", "raspy", "rumbling", "heavy"])
        is_whisper = any(w in p for w in ["whisper", "whispering", "breathy", "intimate", "quiet", "soft", "hushed"])
        is_urgent = any(w in p for w in ["urgent", "panicked", "fast", "tense", "nervous", "rushed", "frantic"])
        is_slow = any(w in p for w in ["slow", "ominous", "calm", "deliberate", "measured", "chilling"])

        # 4. Select Base Kokoro Vectors
        blend_weights: Dict[str, float] = {}
        if is_monster:
            blend_weights = {"am_onyx": 0.70, "am_fenrir": 0.30}
            base_gender = "Otherworldly"
            base_badge = "VOID"
            base_color = "#e11d48"
        elif is_female:
            base_gender = "Female"
            base_badge = "FEM"
            base_color = "#ec4899"
            if is_british:
                blend_weights = {"bf_emma": 0.65, "bf_isabella": 0.35}
            elif is_whisper or is_young:
                blend_weights = {"af_sarah": 0.70, "af_nicole": 0.30}
            else:
                blend_weights = {"af_bella": 0.60, "af_sarah": 0.40}
        else:
            base_gender = "Male"
            base_badge = "MALE"
            base_color = "#0ea5e9"
            if is_british:
                blend_weights = {"bm_george": 0.75, "bm_daniel": 0.25}
            elif is_deep or is_elderly:
                blend_weights = {"am_adam": 0.65, "am_onyx": 0.35}
            elif is_urgent:
                blend_weights = {"am_michael": 0.70, "am_eric": 0.30}
            else:
                blend_weights = {"am_adam": 0.50, "am_michael": 0.50}

        # 5. DSP Parameter Tuning
        pitch_shift = 0.0
        warmth_db = 0.0
        clarity_db = 0.0
        reverb = 0.0
        speed = 1.0

        if is_monster:
            pitch_shift = -5.0
            warmth_db = 6.0
            speed = 0.85
            reverb = 0.12
        elif is_deep or is_elderly:
            pitch_shift = -2.5
            warmth_db = 4.0
            clarity_db = 1.0
            speed = 0.88
        elif is_young:
            pitch_shift = 2.5
            clarity_db = 3.0
            speed = 1.08
        elif is_whisper:
            clarity_db = 4.0
            warmth_db = -1.5
            reverb = 0.08
            speed = 0.92

        if is_urgent:
            speed = max(speed, 1.15)
        elif is_slow:
            speed = min(speed, 0.85)

        # Build timbre description
        timbre_parts = []
        if is_deep: timbre_parts.append("Deep")
        if is_elderly: timbre_parts.append("Weathered")
        if is_whisper: timbre_parts.append("Breathy Whisper")
        if is_urgent: timbre_parts.append("Tense")
        if not timbre_parts: timbre_parts.append("Balanced, Expressive")
        timbre_str = ", ".join(timbre_parts) + f" ({base_gender}, {'British' if is_british else 'American'})"

        return {
            "gender": base_gender,
            "accent": "British" if is_british else "American",
            "badge": base_badge,
            "color": base_color,
            "blend_weights": blend_weights,
            "pitch_shift": pitch_shift,
            "warmth_db": warmth_db,
            "clarity_db": clarity_db,
            "reverb": reverb,
            "speed": speed,
            "timbre": timbre_str
        }

    def design_voice(
        self,
        prompt: str,
        name: Optional[str] = None,
        sample_text: Optional[str] = None
    ) -> Dict[str, Any]:
        """Generates a complete voice archetype from prompt text."""
        p_clean = prompt.strip()
        if not p_clean:
            raise ValueError("Voice prompt cannot be empty.")

        parsed = self.parse_voice_prompt(p_clean)

        # Generate unique voice ID
        hash_seed = f"{p_clean}_{parsed['gender']}_{parsed['speed']:.2f}_{parsed['pitch_shift']:.1f}"
        voice_hash = hashlib.md5(hash_seed.encode("utf-8")).hexdigest()[:8]
        voice_id = f"custom_voice_{voice_hash}"

        # Default sample transcript if not provided
        default_transcript = sample_text.strip() if (sample_text and sample_text.strip()) else (
            "In the deepest shadows of the abandoned corridor, something began to move."
        )

        # Synthesize reference audio
        kokoro = self._ensure_kokoro()
        
        # Synthesize raw audio using blended vector
        raw_result = kokoro.synthesize_block(
            text=default_transcript,
            voice_id="custom_blend",
            blend_weights=parsed["blend_weights"],
            speed=parsed["speed"],
            gain=1.0,
            pitch_shift=parsed["pitch_shift"],
            warmth=parsed["warmth_db"],
            clarity=parsed["clarity_db"],
            reverb=parsed["reverb"],
            fx_filter="none"
        )

        if "error" in raw_result:
            raise RuntimeError(f"Voice generation failed: {raw_result['error']}")

        # Save to permanent reference audio directory
        ref_filename = f"{voice_id}.wav"
        ref_path = VOICES_DIR / ref_filename
        
        src_cache = BASE_DIR / "cache" / f"{raw_result['hash']}.wav"
        if src_cache.exists():
            data, sr = sf.read(str(src_cache))
            sf.write(str(ref_path), data, sr)
        else:
            raise FileNotFoundError(f"Generated cache audio not found: {src_cache}")

        # Derive readable name if not given
        if not name or not name.strip():
            words = [w.capitalize() for w in re.sub(r'[^a-zA-Z0-9\s]', '', p_clean).split() if len(w) > 2]
            name = " ".join(words[:3]) or f"Custom {parsed['gender']} Voice"

        # Archetype metadata record
        voice_record = {
            "id": voice_id,
            "name": name.strip(),
            "engine": "fish_s2",
            "gender": parsed["gender"],
            "accent": parsed["accent"],
            "flag": "🇬🇧" if parsed["accent"] == "British" else "🇺🇸",
            "timbre": parsed["timbre"],
            "genre": ["Custom", "AI Designed"],
            "badge": parsed["badge"],
            "color": parsed["color"],
            "default_emotion_tag": f"[{p_clean[:60]}]",
            "reference_audio": f"voices/reference/{ref_filename}",
            "reference_text": default_transcript
        }

        # Persist into fish_voices_metadata.json
        self._register_voice_metadata(voice_record)

        return {
            "success": True,
            "voice": voice_record,
            "audio_url": f"/api/audio/{ref_filename}",
            "duration": raw_result.get("duration", 4.5)
        }

    def _register_voice_metadata(self, new_voice: Dict[str, Any]):
        """Persists the newly designed voice so it stays available across sessions."""
        voices = []
        if FISH_VOICES_FILE.exists():
            try:
                with open(FISH_VOICES_FILE, "r", encoding="utf-8") as f:
                    voices = json.load(f)
            except Exception:
                voices = []

        # Replace existing or append
        existing_idx = next((i for i, v in enumerate(voices) if v["id"] == new_voice["id"]), None)
        if existing_idx is not None:
            voices[existing_idx] = new_voice
        else:
            voices.append(new_voice)

        with open(FISH_VOICES_FILE, "w", encoding="utf-8") as f:
            json.dump(voices, f, indent=2, ensure_ascii=False)
