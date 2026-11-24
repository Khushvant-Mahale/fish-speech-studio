import json
import os
import re
import time
import uuid

from pathlib import Path

from typing import Any, Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent.parent

PROJECTS_DIR = BASE_DIR / "projects"
FOLDERS_DIR = PROJECTS_DIR / "folders"

INPUT_DIR = BASE_DIR / "input"

OUTPUT_DIR = BASE_DIR / "output"

VOICES_FILE = BASE_DIR / "core" / "voices_metadata.json"

PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
FOLDERS_DIR.mkdir(parents=True, exist_ok=True)

class ProjectManager:

    # Keyword patterns for speaker attribution

    FEMALE_CUES = re.compile(r"\b(she|her|woman|girl|mother|lady|mrs|sister|daughter|female)\b", re.IGNORECASE)

    MALE_CUES = re.compile(r"\b(he|him|his|man|boy|father|mr|brother|son|guy|male)\b", re.IGNORECASE)

    CHILD_CUES = re.compile(r"\b(child|little boy|little girl|kid|toddler|baby)\b", re.IGNORECASE)

    # Keyword patterns for delivery style and emotion

    WHISPER_CUES = re.compile(r"\b(whisper|whispered|whispering|breathed|hissed|murmured|faintly|low voice|softly|quietly)\b", re.IGNORECASE)

    SCREAM_CUES = re.compile(r"\b(scream|screamed|screaming|shout|shouted|shouting|yelled|yelling|cried out|panicked|shrieked|bellowed|hollered)\b", re.IGNORECASE)

    DIALOGUE_INTRO_CUES = re.compile(r"\b(whispered|screamed|said|asked|shouted|cried|murmured|replied|answered|called out|muttered)[,:]\s*$", re.IGNORECASE)

    def __init__(self):

        self._preset_blends_cache = None

    def _get_preset_blends(self) -> Dict[str, Dict[str, float]]:

        if self._preset_blends_cache is None:

            self._preset_blends_cache = {}

            if VOICES_FILE.exists():

                try:

                    with open(VOICES_FILE, "r", encoding="utf-8") as f:

                        meta = json.load(f)

                    for item in meta:

                        if item.get("is_blend") and "blend_weights" in item:

                            self._preset_blends_cache[item["id"]] = item["blend_weights"]

                except Exception:

                    pass

        return self._preset_blends_cache

    def get_project_path(self, project_id: str) -> Path:
        safe_id = re.sub(r"[^a-zA-Z0-9_\-]", "_", project_id) or "default"
        standard = PROJECTS_DIR / f"{safe_id}.json"
        if standard.exists():
            return standard
        try:
            sub = next(PROJECTS_DIR.glob(f"*/{safe_id}.json"), None)
            if sub and sub.exists():
                return sub
        except Exception:
            pass
        return standard

    def auto_direct_blocks(self, blocks: List[Dict], default_voice: str = "blend_fenrir_onyx", expand_dialogue: bool = True, defaults: Optional[Dict] = None) -> List[Dict]:

        """

        Dynamically directs speech and character casting across blocks.

        Detects quotes, dialogue tags, whispers, screams/exaggerations, and pacing gaps.

        """

        if not blocks:

            return []

        preset_blends = self._get_preset_blends()

        default_is_blend = default_voice in preset_blends

        default_blend_weights = preset_blends.get(default_voice) if default_is_blend else None

        def_speed = float(defaults.get("speed", 0.90)) if defaults and "speed" in defaults else 0.90

        def_gain = float(defaults.get("gain", 1.0)) if defaults and "gain" in defaults else 1.0

        def_pause = float(defaults.get("pause_after", 0.6)) if defaults and "pause_after" in defaults else 0.6

        def_pitch = float(defaults.get("pitch_shift", 0.0)) if defaults and "pitch_shift" in defaults else 0.0

        def_warmth = float(defaults.get("warmth", 0.0)) if defaults and "warmth" in defaults else 0.0

        def_clarity = float(defaults.get("clarity", 0.0)) if defaults and "clarity" in defaults else 0.0

        def_reverb = float(defaults.get("reverb", 0.0)) if defaults and "reverb" in defaults else 0.0

        def_filter = str(defaults.get("fx_filter", "none")) if defaults and "fx_filter" in defaults else "none"

        def_radio = bool(defaults.get("radio_fx", False)) if defaults and "radio_fx" in defaults else (def_filter == "radio")

        # Step 1: Optionally expand blocks that contain both dialogue tags and speech

        expanded_blocks = []

        block_counter = 1

        for b in blocks:

            text = (b.get("text") or "").strip()

            if not text:

                continue

            # Preserve non-spoken Scene Headings

            if b.get("type") == "heading" or not b.get("is_spoken", True):

                expanded_blocks.append({

                    "id": b.get("id") or f"h_{block_counter}",

                    "text": text,

                    "_is_heading": True,

                    "_orig": b

                })

                block_counter += 1

                continue

            if text.endswith(":"):

                expanded_blocks.append({

                    "id": b.get("id") or f"b_{block_counter}",

                    "text": text,

                    "_orig": b

                })

                block_counter += 1

                continue

            # Check unquoted lead-in: "A little boy whispered, Why did you leave us outside?"
            unquoted_match = re.match(r'^(.*?\b(?:whispered|whispering|screamed|cried|said|asked|shouted|murmured|replied|muttered|breathed|snarled|demanded|hissed|gasped|growled|sneered|snapped|shrieked)[,:]\s*)([A-Z].{3,}[.?!]?)$', text, re.IGNORECASE)

            # Check quoted dialogue tag: 'She whispered, "Don\'t move."' or inverted 'said Snape, ‘although the Dark Lord...’'
            speech_verbs = r'whispered|whispering|screamed|cried|said|asked|shouted|murmured|replied|muttered|breathed|snarled|demanded|hissed|gasped|growled|sneered|snapped|shrieked|urged|pleaded|repeated|continued|resumed|added'
            quoted_intro_match = re.match(
                rf'^(.*?\b(?:{speech_verbs})(?:\s+[A-Za-z\u2019\'\-]+){{0,3}}[,:]\s*)([\"“\u2018\'](?:[^\r\n\"“”\u2018\u2019\']|(?<=\w)[\'’](?=\w))+[\"”\u2019\'])$',
                text, re.IGNORECASE
            )

            # Check quoted speech followed by tag: '"Don\'t move," she whispered.' or '‘Yes, Bellatrix,’ said Snape, betraying a hint of impatience'
            trailing_tag_match = re.match(
                rf'^([\"“\u2018\'](?:[^\r\n\"“”\u2018\u2019\']|(?<=\w)[\'’](?=\w))+[\"”\u2019\'])\s*([,]?\s*(?:{speech_verbs})?\s*(?:she|he|they|the\s+\w+|[A-Za-z\u2019\'\-]+)?.*)$',
                text, re.IGNORECASE
            )

            if expand_dialogue and unquoted_match:

                tag = unquoted_match.group(1).strip()

                speech = unquoted_match.group(2).strip()

                expanded_blocks.append({"id": f"b_{block_counter}", "text": tag, "_orig": b})

                block_counter += 1

                expanded_blocks.append({"id": f"b_{block_counter}", "text": speech, "_orig": b})

                block_counter += 1

            elif expand_dialogue and quoted_intro_match:

                tag = quoted_intro_match.group(1).strip()

                speech = quoted_intro_match.group(2).strip()

                expanded_blocks.append({"id": f"b_{block_counter}", "text": tag, "_orig": b})

                block_counter += 1

                expanded_blocks.append({"id": f"b_{block_counter}", "text": speech, "_orig": b})

                block_counter += 1

            elif expand_dialogue and trailing_tag_match:

                speech = trailing_tag_match.group(1).strip()

                tag = trailing_tag_match.group(2).strip().lstrip(",").strip()

                expanded_blocks.append({"id": f"b_{block_counter}", "text": speech, "_orig": b})

                block_counter += 1

                if tag:

                    expanded_blocks.append({"id": f"b_{block_counter}", "text": tag, "_orig": b})

                    block_counter += 1

            else:

                expanded_blocks.append({

                    "id": b.get("id") or f"b_{block_counter}",

                    "text": text,

                    "_orig": b

                })

                block_counter += 1

        # Step 2: Contextual classification for all blocks

        directed_blocks = []

        n = len(expanded_blocks)

        for i, item in enumerate(expanded_blocks):

            if item.get("_is_heading"):

                orig = item.get("_orig", {})

                directed_blocks.append({

                    "id": item.get("id"),

                    "type": "heading",

                    "text": item.get("text"),

                    "is_spoken": False,

                    "pause_after": float(orig.get("pause_after", 1.2) or 1.2)

                })

                continue

            text = item["text"]

            orig = item.get("_orig", {})

            prev_text = expanded_blocks[i - 1]["text"] if i > 0 else ""

            prev_prev_text = expanded_blocks[i - 2]["text"] if i > 1 else ""

            next_text = expanded_blocks[i + 1]["text"] if i < n - 1 else ""

            # Check quotes and dialogue nature (supports double quotes and British single quotes)
            is_quoted = bool(re.search(r'[\"“\u2018\'].+?[\"”\u2019\']', text)) or text.startswith(('"', '“', "'", '‘'))

            is_intro_lead = text.endswith(":") or bool(self.DIALOGUE_INTRO_CUES.search(text))

            prev_was_intro = prev_text.endswith(":") or bool(self.DIALOGUE_INTRO_CUES.search(prev_text))

            next_is_trailing = bool(re.match(r'^(?:she|he|they|the\s+\w+|[A-Za-z’\'-]+)?\s*(?:whispered|screamed|said|asked|shouted|murmured|cried|breathed|replied|muttered|snarled|demanded|hissed|sneered)', next_text, re.IGNORECASE))

            is_dialogue = is_quoted or (prev_was_intro and not is_intro_lead)

            # Context specifically tailored for dialogue attribution

            if is_dialogue:

                ctx_parts = [text]

                if prev_was_intro:

                    ctx_parts.append(prev_text)

                    if prev_prev_text.endswith(":") or bool(self.DIALOGUE_INTRO_CUES.search(prev_prev_text)):

                        ctx_parts.append(prev_prev_text)

                if next_is_trailing:

                    ctx_parts.append(next_text)

                context = " ".join(ctx_parts)

            else:

                context = f"{prev_text} {text} {next_text}"

            # Cues detection

            is_whisper = bool(self.WHISPER_CUES.search(text) or (is_dialogue and self.WHISPER_CUES.search(context)))

            is_scream = bool(self.SCREAM_CUES.search(text) or (is_dialogue and (self.SCREAM_CUES.search(context) or "!" in text)))

            is_child = bool(self.CHILD_CUES.search(text) or (is_dialogue and self.CHILD_CUES.search(context)))

            is_female = bool(self.FEMALE_CUES.search(text) or (is_dialogue and self.FEMALE_CUES.search(context)))

            is_male = bool(self.MALE_CUES.search(text) or (is_dialogue and self.MALE_CUES.search(context)))

            # Pacing & Casting Defaults

            voice_id = default_voice

            blend_weights = default_blend_weights if default_is_blend else None

            speed = def_speed

            gain = def_gain

            pause = def_pause

            # Emotion / Acting Tag: NEVER inject random tags!

            # Only use what the user explicitly wrote or tagged.

            emotion_tag = None

            if orig and orig.get("emotion_tag"):

                emotion_tag = orig.get("emotion_tag")

            elif orig and orig.get("text"):

                # Detect inline bracket tag at start of text, e.g. [calm], [anxious, low voice]

                m_inline = re.match(r'^\s*\[(.*?)\]', orig.get("text", ""))

                if m_inline and not m_inline.group(1).lower().startswith("pause"):

                    emotion_tag = f"[{m_inline.group(1).strip()}]"

            elif text:

                m_inline = re.match(r'^\s*\[(.*?)\]', text)

                if m_inline and not m_inline.group(1).lower().startswith("pause"):

                    emotion_tag = f"[{m_inline.group(1).strip()}]"

            if is_intro_lead:

                # Narrator lead-in before dialogue: short pause

                voice_id = default_voice

                blend_weights = default_blend_weights if default_is_blend else None

                speed = 0.90

                gain = 1.0

                pause = 0.4

            elif is_dialogue:

                if is_child and is_whisper:

                    voice_id = "af_river"

                    blend_weights = None

                    speed = 0.78

                    gain = 0.70

                    pause = 1.2

                elif is_whisper:

                    voice_id = "af_river" if is_female else "am_echo"

                    blend_weights = None

                    speed = 0.80

                    gain = 0.75

                    pause = 1.0

                elif is_scream:

                    voice_id = "af_heart" if is_female else "am_fenrir"

                    blend_weights = None

                    speed = 1.04

                    gain = 1.15

                    pause = 0.8

                elif is_female:

                    voice_id = "af_heart"

                    blend_weights = None

                    speed = 0.86

                    gain = 1.0

                    pause = 0.8

                elif is_male:

                    voice_id = "am_michael"

                    blend_weights = None

                    speed = 0.88

                    gain = 1.0

                    pause = 0.8

                else:

                    voice_id = "am_michael"

                    blend_weights = None

                    speed = 0.88

                    gain = 1.0

                    pause = 0.8

            else:

                # Narration

                clean_lower = text.lower()

                if clean_lower.startswith(("day ", "part ", "chapter ", "episode ")):

                    pause = 1.2

                elif is_whisper:

                    voice_id = "af_river" if is_female else "am_echo"

                    blend_weights = None

                    speed = 0.80

                    gain = 0.75

                    pause = 0.9

                elif is_scream:

                    voice_id = "am_fenrir"

                    blend_weights = None

                    speed = 0.96

                    gain = 1.10

                    pause = 0.7

                else:

                    voice_id = default_voice

                    blend_weights = (defaults.get("blend_weights") if (defaults and defaults.get("blend_weights")) else (default_blend_weights if default_is_blend else None))

                    speed = def_speed

                    gain = def_gain

                    pause = float(orig.get("pause_after", def_pause)) if (orig and orig.get("pause_after") is not None) else def_pause

            eng = orig.get("engine") or (defaults.get("engine") if defaults else None) or "fish_s2"

            ref_a = orig.get("reference_audio") or (defaults.get("reference_audio") if defaults else None) or ""

            ref_t = orig.get("reference_text") or (defaults.get("reference_text") if defaults else None) or ""

            if str(eng).strip().lower() in ("none", "null", "undefined"):

                eng = "fish_s2"

            if str(ref_a).strip().lower() in ("none", "null", "undefined"):

                ref_a = ""

            if str(ref_t).strip().lower() in ("none", "null", "undefined"):

                ref_t = ""

            block_data = {

                "id": item["id"],

                "text": text,

                "voice_id": voice_id,

                "engine": str(eng),

                "emotion_tag": emotion_tag,

                "reference_audio": str(ref_a),

                "reference_text": str(ref_t),

                "temperature": float(orig.get("temperature", 0.7) if orig else 0.7),

                "top_p": float(orig.get("top_p", 0.85) if orig else 0.85),

                "speed": round(speed, 2),

                "gain": round(gain, 2),

                "pause_after": round(float(orig.get("pause_after")), 2) if (orig and orig.get("pause_after") is not None) else round(pause, 2),

                "pitch_shift": round(float(orig.get("pitch_shift", def_pitch)), 1) if orig else round(def_pitch, 1),

                "warmth": round(float(orig.get("warmth", def_warmth)), 1) if orig else round(def_warmth, 1),

                "clarity": round(float(orig.get("clarity", def_clarity)), 1) if orig else round(def_clarity, 1),

                "reverb": round(float(orig.get("reverb", def_reverb)), 2) if orig else round(def_reverb, 2),

                "fx_filter": str(orig.get("fx_filter", def_filter)) if orig else def_filter,

                "radio_fx": bool(orig.get("radio_fx", def_radio)) if orig else def_radio

            }

            if orig and orig.get("character_id"):

                block_data["character_id"] = orig.get("character_id")

            if orig and orig.get("is_pause_split"):

                block_data["is_pause_split"] = True

            if blend_weights:

                block_data["blend_weights"] = blend_weights

            # Check if unchanged from original cached audio

            if orig:

                if (orig.get("voice_id") == voice_id and

                    orig.get("speed") == block_data["speed"] and

                    orig.get("gain") == block_data["gain"] and

                    orig.get("pause_after") == block_data["pause_after"] and

                    orig.get("cachedAudioUrl")):

                    block_data["cachedAudioUrl"] = orig.get("cachedAudioUrl")

                    block_data["cachedSig"] = orig.get("cachedSig")

                    if orig.get("duration"):

                        block_data["duration"] = orig.get("duration")

            directed_blocks.append(block_data)

        return directed_blocks

    @staticmethod
    def split_into_sentences(text: str, max_chars: int = 180) -> List[str]:
        """
        Splits a paragraph into individual clean sentences, protecting abbreviations
        and splitting oversized run-on sentences at natural clause boundaries.
        """
        text = text.strip()
        if not text:
            return []

        abbreviations = [
            r"Mr\.", r"Mrs\.", r"Ms\.", r"Dr\.", r"Prof\.", r"Sr\.", r"Jr\.",
            r"vs\.", r"etc\.", r"e\.g\.", r"i\.e\.", r"U\.S\.", r"No\.", r"Vol\.", r"Ch\."
        ]
        protected = text
        for i, abbr in enumerate(abbreviations):
            protected = re.sub(r'\b' + abbr, f"__ABBR_{i}__", protected, flags=re.IGNORECASE)
        protected = re.sub(r'(\d+)\.(\d+)', r'\1__DOT__\2', protected)

        # Split at sentence boundaries: (. ! ?) followed by closing quotes/spaces and capital/quote
        sentence_pattern = re.compile(
            r'(?<=[.!?])(?:[\'\"’”\s]+)(?=[A-Z“\"‘\'\[0-9])'
        )
        raw_splits = [s.strip() for s in sentence_pattern.split(protected) if s.strip()]

        sentences = []
        for s in raw_splits:
            for i, abbr in enumerate(abbreviations):
                clean_abbr = abbr.replace('\\.', '.')
                s = s.replace(f"__ABBR_{i}__", clean_abbr)
            s = s.replace('__DOT__', '.')
            sentences.append(s)

        final_chunks = []
        for s in sentences:
            if len(s) <= max_chars:
                final_chunks.append(s)
                continue

            # Split on semicolon, em-dash, or colon if oversized
            clause_pattern = re.compile(r'(?<=[;—:])\s+')
            sub_clauses = clause_pattern.split(s)
            if len(sub_clauses) > 1 and all(len(c) <= max_chars for c in sub_clauses):
                final_chunks.extend([c.strip() for c in sub_clauses if c.strip()])
                continue

            # Split on commas before conjunctions
            comma_conj = re.compile(r'(?<=,)\s+(?=(?:and|but|or|so|yet|because|although|while|where|which|as|with|who|whom)\b)', re.IGNORECASE)
            sub_commas = comma_conj.split(s)
            if len(sub_commas) > 1:
                curr = ""
                for c in sub_commas:
                    c = c.strip()
                    if not curr:
                        curr = c
                    elif len(curr) + len(c) + 1 <= max_chars:
                        curr += " " + c
                    else:
                        final_chunks.append(curr)
                        curr = c
                if curr:
                    final_chunks.append(curr)
                continue

            # Fallback word-level chunking
            words = s.split()
            curr = ""
            for w in words:
                if not curr:
                    curr = w
                elif len(curr) + len(w) + 1 <= max_chars:
                    curr += " " + w
                else:
                    final_chunks.append(curr)
                    curr = w
            if curr:
                final_chunks.append(curr)

        return final_chunks

    def split_text_into_blocks(self, raw_text: str, default_voice: str = "blend_fenrir_onyx", defaults: Optional[Dict] = None, clean_pauses: bool = True, inline_ellipsis: bool = True, expand_dialogue: bool = True, **kwargs) -> List[Dict]:
        """
        Splits raw story text into structured sentence blocks before emotion tags,
        cleans trailing [pause] tags into card spacing, and dynamically directs them.
        """
        lines = [l.strip() for l in raw_text.replace("\r\n", "\n").split("\n") if l.strip()]
        heading_re = re.compile(
            r'^(?:#+\s*|(?:scene|chapter|act|part|section)\s+\d+|prologue|epilogue)(?:[:\s\-–—].*)?$',
            re.IGNORECASE
        )
        candidate_items = []

        def_speed = float(defaults.get("speed", 0.90)) if defaults and "speed" in defaults else 0.90
        def_gain = float(defaults.get("gain", 1.0)) if defaults and "gain" in defaults else 1.0
        def_pause = float(defaults.get("pause_after", 0.5)) if defaults and "pause_after" in defaults else 0.5
        def_pitch = float(defaults.get("pitch_shift", 0.0)) if defaults and "pitch_shift" in defaults else 0.0
        def_warmth = float(defaults.get("warmth", 0.0)) if defaults and "warmth" in defaults else 0.0
        def_clarity = float(defaults.get("clarity", 0.0)) if defaults and "clarity" in defaults else 0.0
        def_reverb = float(defaults.get("reverb", 0.0)) if defaults and "reverb" in defaults else 0.0
        def_filter = str(defaults.get("fx_filter", "none")) if defaults and "fx_filter" in defaults else "none"
        def_radio = bool(defaults.get("radio_fx", False)) if defaults and "radio_fx" in defaults else (def_filter == "radio")

        for line in lines:
            line_str = line.strip()
            # Check if line is a scene heading / chapter divider
            if (heading_re.match(line_str) or 
                (re.match(r'^\[(?:scene|chapter|act|part|setting|location)\b', line_str, re.I) and line_str.endswith("]")) or
                (line_str.startswith("***") and line_str.endswith("***"))):
                candidate_items.append({"is_heading": True, "text": line_str})
                continue

            if line_str.endswith(":"):
                candidate_items.append({"is_heading": False, "text": line_str})
                continue

            # Split ONLY before non-pause [tag] not at the start of line (e.g. "...? [gasps]Tell me below.")
            def mark_tag_splits(match):
                tag = match.group(0)
                content = tag.strip("[] \t").lower()
                if content.startswith("pause"):
                    return tag
                if match.start() == 0:
                    return tag
                return "\x00" + tag

            line_marked = re.sub(r'\[[^\]]+\]', mark_tag_splits, line_str)
            tag_chunks = [c.strip() for c in line_marked.split("\x00") if c.strip()]

            for chunk in tag_chunks:
                clean_chunk = re.sub(r'^(\[[^\]]+\])([A-Za-z0-9])', r'\1 \2', chunk).strip()
                if not clean_chunk:
                    continue

                item_pause = def_pause
                if clean_pauses:
                    # Strip trailing [pause] or [pause: Xs] and convert duration to card pause_after
                    trailing_pause = re.search(r'\[pause(?:\s*[:=]?\s*([\d.]+)\s*s?)?\]\s*$', clean_chunk, re.IGNORECASE)
                    if trailing_pause:
                        if trailing_pause.group(1):
                            try:
                                item_pause = float(trailing_pause.group(1))
                            except ValueError:
                                pass
                        clean_chunk = re.sub(r'\[pause(?:\s*[:=]?\s*[\d.]+\s*s?)?\]\s*$', '', clean_chunk, flags=re.IGNORECASE).strip()

                    # Strip leading [pause]
                    clean_chunk = re.sub(r'^\s*\[pause(?:\s*[:=]?\s*[\d.]+\s*s?)?\]\s*', '', clean_chunk, flags=re.IGNORECASE).strip()

                if inline_ellipsis:
                    # Convert mid-sentence [pause] to ellipsis '... ' for smooth breath without splitting
                    clean_chunk = re.sub(r'\s*\[pause(?:\s*[:=]?\s*[\d.]+\s*s?)?\]\s*', '... ', clean_chunk, flags=re.IGNORECASE).strip()

                clean_chunk = re.sub(r'\s{2,}', ' ', clean_chunk).strip()

                if clean_chunk:
                    # Keep paragraph intact as a block (like before).
                    # Backend Fish & Kokoro engines auto-chunk long blocks safely during GPU inference.
                    # Only split if a single continuous paragraph is truly massive (>1200 chars).
                    if len(clean_chunk) > 1200:
                        sub_sentences = self.split_into_sentences(clean_chunk, max_chars=800)
                        if sub_sentences:
                            for s in sub_sentences:
                                if s.strip():
                                    candidate_items.append({"is_heading": False, "text": s.strip(), "pause_after": item_pause})
                        else:
                            candidate_items.append({"is_heading": False, "text": clean_chunk, "pause_after": item_pause})
                    else:
                        candidate_items.append({"is_heading": False, "text": clean_chunk, "pause_after": item_pause})

        initial_blocks = []
        for idx, item in enumerate(candidate_items, 1):
            if item.get("is_heading"):
                initial_blocks.append({
                    "id": f"h_{idx}",
                    "type": "heading",
                    "text": item["text"],
                    "is_spoken": False,
                    "pause_after": 1.2
                })
            else:
                item_pause = float(item.get("pause_after", def_pause))
                init_b = {
                    "id": f"b_{idx}",
                    "text": item["text"],
                    "voice_id": default_voice,
                    "speed": round(def_speed, 2),
                    "gain": round(def_gain, 2),
                    "pause_after": round(item_pause, 2),
                    "pitch_shift": round(def_pitch, 1),
                    "warmth": round(def_warmth, 1),
                    "clarity": round(def_clarity, 1),
                    "reverb": round(def_reverb, 2),
                    "fx_filter": def_filter,
                    "radio_fx": def_radio
                }
                if defaults and defaults.get("blend_weights"):
                    init_b["blend_weights"] = defaults["blend_weights"]
                initial_blocks.append(init_b)

        directed = self.auto_direct_blocks(initial_blocks, default_voice=default_voice, expand_dialogue=expand_dialogue, defaults=defaults)
        return self.merge_ultra_small_blocks(directed)

    def merge_ultra_small_blocks(self, blocks: List[Dict], max_chars: int = 90, max_words: int = 16, max_merged_chars: int = 320) -> List[Dict]:

        """

        Merges consecutive ultra-small sentence blocks of the same narrator/voice.

        Preserves dialogue quotes, colons, chapter headers, scene headings, and character boundaries.

        """

        if not blocks:

            return []

        merged = []

        i = 0

        n = len(blocks)

        counter = 1

        while i < n:

            curr = dict(blocks[i])

            if curr.get("type") == "heading" or not curr.get("is_spoken", True):

                curr["id"] = curr.get("id") or f"h_{counter}"

                counter += 1

                merged.append(curr)

                i += 1

                continue

            curr_text = (curr.get("text") or "").strip()

            while i + 1 < n:

                nxt = blocks[i + 1]

                if nxt.get("type") == "heading" or not nxt.get("is_spoken", True):

                    break

                nxt_text = (nxt.get("text") or "").strip()

                # Voice, Character & Emotion matching

                same_engine = (curr.get("engine", "fish_s2") == nxt.get("engine", "fish_s2"))

                same_voice = (curr.get("voice_id") == nxt.get("voice_id"))

                same_char = (curr.get("character_id") == nxt.get("character_id"))

                same_emotion = (curr.get("emotion_tag") == nxt.get("emotion_tag"))

                same_ref = (curr.get("reference_audio") == nxt.get("reference_audio"))

                same_blend = (curr.get("blend_weights") == nxt.get("blend_weights"))

                same_filter = (curr.get("fx_filter", "none") == nxt.get("fx_filter", "none"))

                same_pitch = (curr.get("pitch_shift", 0.0) == nxt.get("pitch_shift", 0.0))

                if not (same_engine and same_voice and same_char and same_emotion and same_ref and same_blend and same_filter and same_pitch):

                    break

                # Never merge colon intro leads

                if curr_text.endswith(":") or nxt_text.endswith(":"):

                    break

                # Never merge chapter/day headers

                if curr_text.lower().startswith(("day ", "part ", "chapter ")) or nxt_text.lower().startswith(("day ", "part ", "chapter ")):

                    break

                # Never merge into a block starting with an emotion tag e.g. [gasps]

                if nxt_text.startswith("[") and not nxt_text.lower().startswith("[pause"):

                    break

                # Never merge across [pause] pacing breaks

                if curr.get("is_pause_split") or nxt.get("is_pause_split") or curr.get("pause_after", 0.6) > 0.8:

                    break

                if "[pause" in curr_text.lower() or "[pause" in nxt_text.lower():

                    break

                # Never merge quoted dialogue with unquoted narrative (supports double quotes and British single quotes)
                quote_pattern = r'[\"“\u2018\'].+?[\"”\u2019\']'
                quote_starts = ('"', '“', '‘', "'")
                curr_has_quotes = bool(re.search(quote_pattern, curr_text)) or curr_text.startswith(quote_starts)
                nxt_has_quotes = bool(re.search(quote_pattern, nxt_text)) or nxt_text.startswith(quote_starts)

                if curr_has_quotes != nxt_has_quotes:

                    break

                # Check if either block is ultra-small

                curr_is_small = len(curr_text) <= max_chars or len(curr_text.split()) <= max_words

                nxt_is_small = len(nxt_text) <= max_chars or len(nxt_text.split()) <= max_words

                if not (curr_is_small or nxt_is_small):

                    break

                potential_len = len(curr_text) + 1 + len(nxt_text)

                if potential_len > max_merged_chars:

                    break

                curr_text = f"{curr_text} {nxt_text}"

                curr["text"] = curr_text

                curr["pause_after"] = nxt.get("pause_after", curr.get("pause_after", 0.6))

                curr.pop("cachedAudioUrl", None)

                curr.pop("cachedSig", None)

                curr.pop("duration", None)

                i += 1

            curr["id"] = f"b_{counter}"

            curr["text"] = curr_text

            counter += 1

            merged.append(curr)

            i += 1

        return merged

    def load_project(self, project_id: str = "default") -> Optional[Dict]:
        # 1. Check persistent database first
        try:
            from core.database import db
            db_proj = db.get_project(project_id)
            if db_proj and isinstance(db_proj, dict):
                # Ensure local disk cache is in sync
                try:
                    path = self.get_project_path(project_id)
                    with open(path, "w", encoding="utf-8") as f:
                        json.dump(db_proj, f, indent=2, ensure_ascii=False)
                except Exception:
                    pass
                return db_proj
        except Exception:
            pass

        # 2. Check local disk file
        path = self.get_project_path(project_id)
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                # Seed into DB
                try:
                    from core.database import db
                    db.save_project(project_id, data)
                except Exception:
                    pass
                return data
            except Exception:
                pass

        # 3. Create default project from sample text if project_id == "default"
        if project_id == "default":
            sample_file = INPUT_DIR / "THE ENDLESS ECLIPSE - Sample.txt"
            if not sample_file.exists():
                sample_file = INPUT_DIR / "THE ENDLESS ECLIPSE.txt"
            if sample_file.exists():
                with open(sample_file, "r", encoding="utf-8-sig") as f:
                    text = f.read()
            else:
                text = "At six fourteen in the morning, the sun failed to rise.\nAt six fifteen, the dead began calling home."

            blocks = self.split_text_into_blocks(text)
            project_data = {
                "id": project_id,
                "title": "The Endless Eclipse - Episode 1",
                "blocks": blocks,
                "master_filename": "endless_eclipse_master.wav"
            }
            self.save_project(project_data, project_id)
            return project_data

        return None

    # Alias for load_project
    def get_project(self, project_id: str = "default") -> Optional[Dict]:
        return self.load_project(project_id)

    def save_project(self, project_data: Dict, project_id: str = "default") -> None:
        if not project_id:
            project_id = project_data.get("id") or "default"
        project_data["id"] = project_id
        path = self.get_project_path(project_id)
        if path.exists() and "owner_id" not in project_data:
            try:
                with open(path, "r", encoding="utf-8") as exf:
                    ex_d = json.load(exf)
                    if ex_d.get("owner_id"):
                        project_data["owner_id"] = ex_d["owner_id"]
            except Exception:
                pass
        # Write to local disk cache
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(project_data, f, indent=2, ensure_ascii=False)
        except Exception:
            pass
        # Persist to relational database (survives container rebuilds)
        try:
            from core.database import db
            db.save_project(project_id, project_data)
        except Exception:
            pass

    def list_projects(self, engine: Optional[str] = None, folder_id: Optional[str] = None, owner_id: Optional[str] = None) -> List[Dict]:
        projects_dict = {}

        # 1. Fetch all projects from persistent database
        try:
            from core.database import db
            db_projs = db.list_projects(owner_id=owner_id)
            for p in db_projs:
                if isinstance(p, dict) and p.get("id"):
                    projects_dict[p["id"]] = p
        except Exception:
            pass

        # 2. Read disk projects and merge
        for p in PROJECTS_DIR.glob("*.json"):
            if p.name in ("config.json", "users.json", "sessions.json", "tier.json", "kaggle_session.json"):
                continue
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict) and data.get("id"):
                    pid = data["id"]
                    if pid not in projects_dict:
                        projects_dict[pid] = data
                        # Sync back to DB
                        try:
                            from core.database import db
                            db.save_project(pid, data)
                        except Exception:
                            pass
            except Exception:
                pass

        # 3. Format project summary cards
        formatted_projects = []
        for pid, data in projects_dict.items():
            try:
                proj_owner = data.get("owner_id")
                if owner_id and proj_owner != owner_id:
                    continue
                path = self.get_project_path(pid)
                mtime = path.stat().st_mtime if path.exists() else (float(data.get("updated_at") or 0.0) or time.time())
                blocks = data.get("blocks", [])
                rendered_count = sum(1 for b in blocks if b.get("cachedAudioUrl"))
                total_dur = sum(float(b.get("duration", 0.0) or 0.0) for b in blocks if b.get("cachedAudioUrl"))
                voices_used = list(dict.fromkeys(b.get("voice_id") for b in blocks if b.get("voice_id")))
                preview_audio = next((b.get("cachedAudioUrl") for b in blocks if b.get("cachedAudioUrl")), None)
                master_file = data.get("master_filename")
                master_exists = bool(master_file and (OUTPUT_DIR / master_file).exists())
                chars = data.get("characters", [])
                char_count = len(chars) if isinstance(chars, list) else 0

                proj_engine = data.get("engine")
                if not proj_engine:
                    dv = str(data.get("default_voice", ""))
                    fb = str(blocks[0].get("voice_id", "")) if blocks else ""
                    if dv.startswith(("am_", "af_", "bm_", "bf_", "blend_")) or fb.startswith(("am_", "af_", "bm_", "bf_", "blend_")):
                        proj_engine = "kokoro"
                    else:
                        proj_engine = "fish_s2"

                if engine and proj_engine != engine:
                    continue

                proj_folder_id = data.get("folder_id")
                if folder_id is not None:
                    if folder_id in ("none", "root"):
                        if proj_folder_id:
                            continue
                    elif proj_folder_id != folder_id:
                        continue

                formatted_projects.append({
                    "id": data.get("id", pid),
                    "title": data.get("title", pid),
                    "engine": proj_engine,
                    "default_voice": data.get("default_voice", "voice_stanley_narrator" if proj_engine == "fish_s2" else "am_adam"),
                    "folder_id": proj_folder_id,
                    "parent_series_id": data.get("parent_series_id"),
                    "chapter_number": data.get("chapter_number"),
                    "is_stub": bool(data.get("is_stub", False)),
                    "word_count": data.get("word_count", 0),
                    "estimated_minutes": data.get("estimated_minutes", 0.0),
                    "block_count": len(blocks),
                    "rendered_count": rendered_count,
                    "total_duration": round(total_dur, 1),
                    "voices_used": voices_used[:5],
                    "voice_count": len(voices_used),
                    "character_count": char_count,
                    "preview_audio": preview_audio,
                    "master_exists": master_exists,
                    "master_filename": master_file if master_exists else None,
                    "updated_at": mtime
                })
            except Exception:
                pass

        formatted_projects.sort(key=lambda x: x["updated_at"], reverse=True)
        return formatted_projects

    def duplicate_project(self, project_id: str) -> Optional[Dict]:
        source_path = self.get_project_path(project_id)
        if not source_path.exists():
            return None

        with open(source_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        import uuid
        new_id = f"proj_{uuid.uuid4().hex[:8]}"
        data["id"] = new_id
        orig_title = data.get("title", "Project")
        data["title"] = f"{orig_title} (Copy)"

        self.save_project(data, new_id)
        return data

    def copy_project_to_engine(self, project_id: str, target_engine: str) -> Optional[Dict]:
        """
        Duplicates a project and converts it to run in the target studio engine
        (Kokoro <-> Fish S2), with intelligent voice mapping and clean audio state.
        """
        source_path = self.get_project_path(project_id)
        if not source_path.exists():
            return None

        with open(source_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        import uuid
        import re
        new_id = f"proj_{uuid.uuid4().hex[:8]}"
        orig_title = data.get("title", "Project")
        target_engine = "fish_s2" if target_engine == "fish_s2" else "kokoro"
        engine_label = "Fish S2" if target_engine == "fish_s2" else "Kokoro"

        clean_base_title = re.sub(r'\s*\((?:Kokoro|Fish S2|Copy)\)$', '', orig_title, flags=re.IGNORECASE).strip()
        data["id"] = new_id
        data["title"] = f"{clean_base_title} ({engine_label})"
        data["engine"] = target_engine

        KOKORO_TO_FISH_MAP = {
            "am_adam": "voice_stanley_narrator",
            "am_michael": "fish_protagonist_male",
            "af_bella": "fish_protagonist_female",
            "af_sarah": "fish_protagonist_female",
            "bm_george": "fish_elder_investigator",
            "bf_emma": "fish_protagonist_female",
            "am_fenrir": "voice_stanley_narrator",
            "am_onyx": "voice_stanley_narrator",
            "blend_fenrir_onyx": "voice_stanley_narrator",
            "blend_george_onyx": "fish_elder_investigator",
            "custom_blend": "voice_stanley_narrator"
        }

        FISH_TO_KOKORO_MAP = {
            "fish_narrator_dark": "am_adam",
            "voice_stanley_narrator": "am_adam",
            "fish_protagonist_male": "am_michael",
            "fish_protagonist_female": "af_bella",
            "fish_elder_investigator": "bm_george",
            "fish_shadow_entity": "am_fenrir",
            "voice_walter_white": "bm_george",
            "voice_saul_goodman": "am_michael",
            "voice_morgan_freeman": "bm_george",
            "voice_david_attenborough": "bm_george",
        }

        old_def_voice = str(data.get("default_voice", ""))
        if target_engine == "fish_s2":
            new_def_voice = KOKORO_TO_FISH_MAP.get(old_def_voice, "voice_stanley_narrator")
        else:
            new_def_voice = FISH_TO_KOKORO_MAP.get(old_def_voice, "am_adam")
        data["default_voice"] = new_def_voice

        blocks = data.get("blocks", [])
        for b in blocks:
            b["engine"] = target_engine
            curr_v = str(b.get("voice_id", ""))
            if target_engine == "fish_s2":
                b["voice_id"] = KOKORO_TO_FISH_MAP.get(curr_v, new_def_voice)
                if not b.get("emotion_tag"):
                    b["emotion_tag"] = "[slow, dramatic narration]"
            else:
                b["voice_id"] = FISH_TO_KOKORO_MAP.get(curr_v, new_def_voice)
                if b.get("text"):
                    # Strip non-pause emotion tags so Kokoro doesn't speak bracketed prompts
                    b["text"] = re.sub(r'\[(?!\s*pause)(.*?)\]', '', b["text"]).strip()
                    b["text"] = re.sub(r'\s{2,}', ' ', b["text"])

            b["cachedAudioUrl"] = None
            b["cachedSig"] = None
            b["duration"] = 0.0

        data["master_filename"] = f"{new_id}_master.wav"
        self.save_project(data, new_id)
        return data

    def rename_project(self, project_id: str, new_title: str) -> bool:

        path = self.get_project_path(project_id)

        if not path.exists():

            return False

        with open(path, "r", encoding="utf-8") as f:

            data = json.load(f)

        data["title"] = new_title.strip() or "Untitled Project"

        self.save_project(data, project_id)

        return True

    def delete_project(self, project_id: str) -> bool:
        deleted = False
        try:
            from core.database import db
            if db.delete_project(project_id):
                deleted = True
        except Exception:
            pass

        path = self.get_project_path(project_id)
        if path.exists():
            try:
                path.unlink()
                deleted = True
            except Exception:
                pass

        return deleted

    # ------------------ FOLDER & AUDIOBOOK SERIES MANAGEMENT ------------------
    def get_folder_path(self, folder_id: str) -> Path:
        safe_id = re.sub(r"[^a-zA-Z0-9_\-]", "_", folder_id) or "folder_default"
        return FOLDERS_DIR / f"{safe_id}.json"

    def list_folders(self, engine: Optional[str] = None, parent_id: Optional[str] = None, include_all: bool = False, owner_id: Optional[str] = None) -> List[Dict]:
        folders = []
        if not FOLDERS_DIR.exists():
            return []

        all_projects = self.list_projects(owner_id=owner_id)
        proj_map = {p["id"]: p for p in all_projects}

        raw_folders = []
        for fp in FOLDERS_DIR.glob("*.json"):
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    data = json.load(f)

                f_owner = data.get("owner_id")
                if owner_id:
                    if f_owner != owner_id:
                        continue

                f_engine = data.get("engine", "fish_s2")
                if engine and f_engine != engine:
                    continue

                f_id = data.get("id", fp.stem)
                chapter_order = data.get("chapter_order", [])

                ch_ids = list(chapter_order)
                for pid, pdata in proj_map.items():
                    if pdata.get("folder_id") == f_id and pid not in ch_ids:
                        ch_ids.append(pid)

                total_sentences = 0
                total_rendered = 0
                total_duration = 0.0
                voices_set = set()
                preview_audio = None

                for cid in ch_ids:
                    p = proj_map.get(cid)
                    if not p:
                        continue
                    total_sentences += (p.get("block_count") or 0)
                    total_rendered += (p.get("rendered_count") or 0)
                    total_duration += (p.get("total_duration") or 0.0)
                    if p.get("voices_used"):
                        voices_set.update(p["voices_used"])
                    if not preview_audio and p.get("preview_audio"):
                        preview_audio = p["preview_audio"]

                characters = self.get_folder_master_cast(f_id)
                if not characters:
                    characters = data.get("characters", []) or data.get("master_cast", [])

                raw_folders.append({
                    "id": f_id,
                    "title": data.get("title", fp.stem),
                    "author": data.get("author", ""),
                    "description": data.get("description", ""),
                    "engine": f_engine,
                    "parent_id": data.get("parent_id"),
                    "cover_image": data.get("cover_image"),
                    "chapter_count": len(ch_ids),
                    "chapter_order": ch_ids,
                    "block_count": total_sentences,
                    "rendered_count": total_rendered,
                    "total_duration": round(total_duration, 1),
                    "voices_used": list(voices_set)[:5],
                    "character_count": len(characters),
                    "characters": characters,
                    "master_cast": characters,
                    "preview_audio": preview_audio,
                    "created_at": data.get("created_at", fp.stat().st_ctime),
                    "updated_at": data.get("updated_at", fp.stat().st_mtime)
                })
            except Exception as e:
                print(f"[ProjectManager] Error listing folder {fp}: {e}")

        # Map subfolders to parent folders
        subfolders_by_parent = {}
        for f in raw_folders:
            p_pid = f.get("parent_id")
            if p_pid:
                subfolders_by_parent.setdefault(p_pid, []).append(f)

        for f in raw_folders:
            sfs = subfolders_by_parent.get(f["id"], [])
            f["subfolders"] = [{"id": s["id"], "title": s["title"], "chapter_count": s["chapter_count"]} for s in sfs]
            f["subfolder_count"] = len(sfs)
            if sfs:
                f["total_series_chapters"] = f["chapter_count"] + sum(s.get("chapter_count", 0) for s in sfs)
                f["total_series_sentences"] = f["block_count"] + sum(s.get("block_count", 0) for s in sfs)
                f["total_series_duration"] = round(f["total_duration"] + sum(s.get("total_duration", 0.0) for s in sfs), 1)

        if not include_all:
            if parent_id is not None:
                folders = [f for f in raw_folders if f.get("parent_id") == parent_id]
            else:
                folders = [f for f in raw_folders if not f.get("parent_id")]
        else:
            folders = raw_folders

        folders.sort(key=lambda x: x["updated_at"], reverse=True)
        return folders

    def get_folder(self, folder_id: str, owner_id: Optional[str] = None) -> Optional[Dict]:
        fp = self.get_folder_path(folder_id)
        if not fp.exists():
            return None
        try:
            with open(fp, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return None

        f_owner = data.get("owner_id")
        if owner_id and f_owner and f_owner != owner_id:
            return None

        f_id = data.get("id", folder_id)
        chapter_order = data.get("chapter_order", [])

        all_projs = {p["id"]: p for p in self.list_projects(owner_id=owner_id)}
        chapters = []
        for cid in chapter_order:
            if cid in all_projs:
                chapters.append(all_projs[cid])

        for pid, pdata in all_projs.items():
            if pdata.get("folder_id") == f_id and pid not in [c["id"] for c in chapters]:
                chapters.append(pdata)

        data["chapters"] = chapters
        data["chapter_ids"] = [c["id"] for c in chapters]
        data["chapter_count"] = len(chapters)
        data["block_count"] = sum(c.get("block_count", 0) for c in chapters)
        data["rendered_count"] = sum(c.get("rendered_count", 0) for c in chapters)
        data["total_duration"] = round(sum(c.get("total_duration", 0.0) for c in chapters), 1)

        # Detect and attach subfolders
        subfolders = []
        for s_fp in FOLDERS_DIR.glob("*.json"):
            try:
                with open(s_fp, "r", encoding="utf-8") as sf:
                    s_data = json.load(sf)
                    if s_data.get("parent_id") == f_id:
                        s_order = s_data.get("chapter_order", [])
                        subfolders.append({
                            "id": s_data.get("id", s_fp.stem),
                            "title": s_data.get("title", s_fp.stem),
                            "author": s_data.get("author", ""),
                            "description": s_data.get("description", ""),
                            "chapter_count": len(s_order),
                            "parent_id": f_id,
                            "updated_at": s_data.get("updated_at", 0)
                        })
            except Exception:
                pass
        subfolders.sort(key=lambda x: x.get("title", ""))
        data["subfolders"] = subfolders
        data["subfolder_count"] = len(subfolders)

        # If this folder is a subfolder, attach parent folder info
        parent_id = data.get("parent_id")
        if parent_id:
            p_fp = self.get_folder_path(parent_id)
            if p_fp.exists():
                try:
                    with open(p_fp, "r", encoding="utf-8") as pf:
                        p_data = json.load(pf)
                        data["parent_folder"] = {
                            "id": p_data.get("id", parent_id),
                            "title": p_data.get("title", "Parent Series"),
                            "author": p_data.get("author", "")
                        }
                except Exception:
                    pass

        # Attach Unified Master Cast
        master_cast = self.get_folder_master_cast(f_id)
        if not data.get("characters"):
            data["characters"] = master_cast
        data["master_cast"] = data.get("characters") or master_cast
        data["character_count"] = len(data["master_cast"])

        # Attach Director Settings & Preferences
        data["director_settings"] = self.get_folder_director_settings(f_id)

        return data

    def create_folder(
        self,
        title: str,
        author: str = "",
        description: str = "",
        engine: str = "fish_s2",
        characters: Optional[List[Dict]] = None,
        cover_image: Optional[str] = None,
        parent_id: Optional[str] = None,
        series_order: int = 0,
        owner_id: Optional[str] = None
    ) -> Dict:
        folder_id = f"folder_{uuid.uuid4().hex[:8]}"
        now = time.time()
        folder_data = {
            "id": folder_id,
            "title": title.strip() or "Untitled Audiobook Series",
            "author": author.strip(),
            "description": description.strip(),
            "engine": engine,
            "parent_id": parent_id,
            "cover_image": cover_image,
            "characters": characters or [],
            "chapter_order": [],
            "owner_id": owner_id,
            "series_order": series_order,
            "created_at": now,
            "updated_at": now
        }
        self.save_folder(folder_data, folder_id)
        return folder_data

    def get_folder_master_cast(self, folder_id: str) -> List[Dict]:
        """
        Retrieves the Unified Master Cast for a folder.
        If the folder is a subfolder (e.g. Book inside a Series),
        it seamlessly merges characters from both the parent series and current folder.
        If a parent series has 0 characters, it aggregates characters from its subfolders.
        """
        fp = self.get_folder_path(folder_id)
        if not fp.exists():
            return []
        try:
            with open(fp, "r", encoding="utf-8") as rf:
                f = json.load(rf)
        except Exception:
            return []

        all_chars = list(f.get("characters") or f.get("master_cast") or [])
        seen_names = {c.get("name", "").strip().lower() for c in all_chars if c.get("name")}

        parent_id = f.get("parent_id")
        if parent_id:
            p_fp = self.get_folder_path(parent_id)
            if p_fp.exists():
                try:
                    with open(p_fp, "r", encoding="utf-8") as prf:
                        parent_f = json.load(prf)
                    for pc in (parent_f.get("characters") or parent_f.get("master_cast") or []):
                        p_name = pc.get("name", "").strip().lower()
                        if p_name and p_name not in seen_names:
                            all_chars.append(dict(pc))
                            seen_names.add(p_name)
                except Exception:
                    pass

        # If folder itself has no characters, collect from subfolders
        if not all_chars:
            for s_fp in FOLDERS_DIR.glob("*.json"):
                try:
                    with open(s_fp, "r", encoding="utf-8") as sf:
                        s_data = json.load(sf)
                    if s_data.get("parent_id") == folder_id:
                        for sc in (s_data.get("characters") or s_data.get("master_cast") or []):
                            s_name = sc.get("name", "").strip().lower()
                            if s_name and s_name not in seen_names:
                                all_chars.append(dict(sc))
                                seen_names.add(s_name)
                except Exception:
                    pass

        return all_chars

    def add_characters_to_master_cast(self, folder_id: str, new_characters: List[Dict]) -> bool:
        """
        Appends new characters to folder Master Cast and synchronizes with parent series folder.
        """
        if not new_characters:
            return True
        f = self.get_folder(folder_id)
        if not f:
            return False

        existing = f.get("characters", [])
        existing_names = {c.get("name", "").strip().lower() for c in existing if c.get("name")}
        added = False
        for nc in new_characters:
            name = nc.get("name", "").strip()
            if name and name.lower() not in existing_names:
                existing.append(dict(nc))
                existing_names.add(name.lower())
                added = True

        if added:
            f["characters"] = existing
            self.save_folder(f, folder_id)

        parent_id = f.get("parent_id")
        if parent_id:
            parent_f = self.get_folder(parent_id)
            if parent_f:
                p_existing = parent_f.get("characters", [])
                p_names = {c.get("name", "").strip().lower() for c in p_existing if c.get("name")}
                p_added = False
                for nc in new_characters:
                    name = nc.get("name", "").strip()
                    if name and name.lower() not in p_names:
                        p_existing.append(dict(nc))
                        p_names.add(name.lower())
                        p_added = True
                if p_added:
                    parent_f["characters"] = p_existing
                    self.save_folder(parent_f, parent_id)

        return True

    def get_folder_director_settings(self, folder_id: str) -> Dict[str, Any]:
        """
        Retrieves the saved Director Settings & Preferences for a series/book folder.
        If current folder doesn't have custom settings, it inherits from the parent series.
        """
        fp = self.get_folder_path(folder_id)
        if not fp.exists():
            return {}
        try:
            with open(fp, "r", encoding="utf-8") as rf:
                data = json.load(rf)
            settings = data.get("director_settings") or {}
            if not settings and data.get("parent_id"):
                parent_id = data["parent_id"]
                pf = self.get_folder_path(parent_id)
                if pf.exists():
                    with open(pf, "r", encoding="utf-8") as prf:
                        pdata = json.load(prf)
                    settings = pdata.get("director_settings") or {}
            return settings
        except Exception:
            return {}

    def save_folder_director_settings(self, folder_id: str, settings: Dict[str, Any]) -> bool:
        """
        Saves Director Settings & Preferences to the folder and bubbles up to parent series.
        """
        fp = self.get_folder_path(folder_id)
        if not fp.exists():
            return False
        try:
            with open(fp, "r", encoding="utf-8") as rf:
                data = json.load(rf)
            data["director_settings"] = dict(settings)
            data["updated_at"] = time.time()
            self.save_folder(data, folder_id)

            parent_id = data.get("parent_id")
            if parent_id:
                p_fp = self.get_folder_path(parent_id)
                if p_fp.exists():
                    with open(p_fp, "r", encoding="utf-8") as prf:
                        p_data = json.load(prf)
                    p_data["director_settings"] = dict(settings)
                    p_data["updated_at"] = time.time()
                    self.save_folder(p_data, parent_id)
            return True
        except Exception as e:
            print(f"[ProjectManager] Failed to save folder director settings: {e}")
            return False

    def generate_series_from_epub(
        self,
        epub_path: str,
        title: Optional[str] = None,
        author: Optional[str] = None,
        description: Optional[str] = None,
        engine: str = "fish_s2",
        selected_book_indices: Optional[List[int]] = None,
        selected_chapters: Optional[Dict[str, List[int]]] = None
    ) -> Dict:
        """
        Breaks down an eBook (including multi-volume boxsets like Harry Potter 1-7)
        into a Series Folder with Book subfolders and lightweight Chapter Cards.
        Chapter text and AI directing are deferred until the user opens each chapter.
        """
        from core.epub_parser import inspect_epub

        if not os.path.exists(epub_path):
            raise FileNotFoundError(f"EPUB file not found: {epub_path}")

        info = inspect_epub(epub_path)
        books = info.get("books", [])
        if not books:
            raise ValueError("No readable books or chapters found in EPUB.")

        first_book = books[0]
        series_title = (title or "").strip() or first_book.get("title") or "Untitled Audiobook Series"
        series_author = (author or "").strip() or first_book.get("author") or "Unknown Author"
        series_desc = (description or "").strip() or f"Complete audio edition of {series_title} by {series_author}."

        is_multi_book = len(books) > 1

        # 1. Create root series folder
        root_folder = self.create_folder(
            title=series_title,
            author=series_author,
            description=series_desc,
            engine=engine,
            parent_id=None
        )
        root_folder_id = root_folder["id"]

        total_chapters_created = 0
        subfolder_list = []

        if is_multi_book:
            for b in books:
                b_idx = b["book_index"]
                if selected_book_indices and b_idx not in selected_book_indices:
                    continue

                b_title = b.get("title") or f"Book {b_idx}"
                b_author = b.get("author") or series_author
                b_desc = f"Book {b_idx} of {series_title} ({len(b.get('chapters', []))} chapters)"

                # Check if specific chapters were selected for this book
                allowed_chs = None
                if selected_chapters:
                    allowed_chs = selected_chapters.get(str(b_idx)) or selected_chapters.get(b_idx)

                # Create subfolder for this book/volume
                sub_folder = self.create_folder(
                    title=b_title,
                    author=b_author,
                    description=b_desc,
                    engine=engine,
                    parent_id=root_folder_id
                )
                sub_id = sub_folder["id"]
                subfolder_list.append(sub_id)

                # Create lightweight chapter stubs
                for ch in b.get("chapters", []):
                    ch_index = ch.get("chapter_index")
                    if allowed_chs is not None and ch_index not in allowed_chs:
                        continue

                    ch_title = ch.get("title") or f"Chapter {ch_index}"
                    ch_info = ProjectManager.parse_chapter_info(ch_title, ch_index)

                    proj_id = f"proj_{uuid.uuid4().hex[:8]}"
                    stub_proj = {
                        "id": proj_id,
                        "title": f"{b_title} - {ch_title}",
                        "engine": engine,
                        "default_voice": "voice_stanley_narrator" if engine == "fish_s2" else "am_adam",
                        "folder_id": sub_id,
                        "parent_series_id": root_folder_id,
                        "chapter_number": ch_info.get("parsed_number") or ch_index,
                        "characters": [],
                        "blocks": [],
                        "is_stub": True,
                        "source_epub": epub_path,
                        "epub_file_path": ch.get("file_path"),
                        "epub_anchor": ch.get("anchor", ""),
                        "word_count": ch.get("word_count", 0),
                        "estimated_minutes": ch.get("estimated_minutes", 0.0),
                        "created_at": time.time(),
                        "updated_at": time.time(),
                        "master_filename": f"{proj_id}_master.wav"
                    }
                    self.save_project(stub_proj, proj_id)
                    self.add_project_to_folder(sub_id, proj_id)
                    total_chapters_created += 1

                # Natural sort chapters in this subfolder
                self.sort_folder_chapters(sub_id)

        else:
            # Single book
            b = books[0]
            b_idx = b.get("book_index", 1)
            allowed_chs = None
            if selected_chapters:
                allowed_chs = selected_chapters.get(str(b_idx)) or selected_chapters.get(b_idx) or selected_chapters.get("1") or selected_chapters.get(1)

            for ch in b.get("chapters", []):
                ch_index = ch.get("chapter_index")
                if allowed_chs is not None and ch_index not in allowed_chs:
                    continue

                ch_title = ch.get("title") or f"Chapter {ch_index}"
                ch_info = ProjectManager.parse_chapter_info(ch_title, ch_index)

                proj_id = f"proj_{uuid.uuid4().hex[:8]}"
                stub_proj = {
                    "id": proj_id,
                    "title": f"{series_title} - {ch_title}",
                    "engine": engine,
                    "default_voice": "voice_stanley_narrator" if engine == "fish_s2" else "am_adam",
                    "folder_id": root_folder_id,
                    "parent_series_id": root_folder_id,
                    "chapter_number": ch_info.get("parsed_number") or ch_index,
                    "characters": [],
                    "blocks": [],
                    "is_stub": True,
                    "source_epub": epub_path,
                    "epub_file_path": ch.get("file_path"),
                    "epub_anchor": ch.get("anchor", ""),
                    "word_count": ch.get("word_count", 0),
                    "estimated_minutes": ch.get("estimated_minutes", 0.0),
                    "created_at": time.time(),
                    "updated_at": time.time(),
                    "master_filename": f"{proj_id}_master.wav"
                }
                self.save_project(stub_proj, proj_id)
                self.add_project_to_folder(root_folder_id, proj_id)
                total_chapters_created += 1

            self.sort_folder_chapters(root_folder_id)

        return {
            "ok": True,
            "folder_id": root_folder_id,
            "series_title": series_title,
            "is_multi_book": is_multi_book,
            "books_count": len(books),
            "subfolders": subfolder_list,
            "total_chapters": total_chapters_created
        }

    def direct_stub_chapter(
        self,
        project_id: str,
        cast_mode: str = "multi",
        ai_direct: bool = True,
        ai_model: str = "gemini-3.5-flash-lite",
        split_quotes: bool = True,
        acting_tags: bool = True,
        acting_intensity: str = "balanced",
        analysis_temperature: float = 0.7,
        default_voice: Optional[str] = None,
        save_as_folder_default: bool = False,
        progress_callback: Optional[Any] = None
    ) -> Dict:
        """
        Takes an unimported stub chapter created from an eBook, extracts its text,
        chunks into blocks, and directs dialogue and characters using the series Unified Master Cast.
        """
        from core.epub_parser import get_chapter_text
        from core.ai_director import AIDirector

        proj = self.get_project(project_id)
        if not proj:
            raise ValueError(f"Project '{project_id}' not found")

        source_epub = proj.get("source_epub")
        epub_file_path = proj.get("epub_file_path")
        if not source_epub or not epub_file_path:
            raise ValueError(f"Project '{project_id}' does not have an attached EPUB source")

        ch_data = get_chapter_text(source_epub, epub_file_path, chapter_title=proj.get("title", ""))
        raw_text = ch_data.get("text", "")
        if not raw_text:
            raise ValueError("No text could be extracted from chapter")

        engine = proj.get("engine", "fish_s2")
        chosen_voice = default_voice or proj.get("default_voice") or ("voice_stanley_narrator" if engine == "fish_s2" else "am_adam")

        # Split text into narrative and dialogue blocks
        blocks = self.split_text_into_blocks(
            raw_text,
            default_voice=chosen_voice,
            clean_pauses=True,
            inline_ellipsis=True,
            expand_dialogue=split_quotes
        )

        folder_id = proj.get("folder_id")
        master_cast = self.get_folder_master_cast(folder_id) if folder_id else []
        characters = list(master_cast) if master_cast else []

        if ai_direct and blocks:
            # Load voices
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

            cfg = {}
            cfg_p = BASE_DIR / "projects" / "config.json"
            if cfg_p.exists():
                try:
                    with open(cfg_p, "r", encoding="utf-8") as f:
                        cfg = json.load(f)
                except Exception:
                    pass

            ai_dir = AIDirector()
            if ai_model and ("llama" in str(ai_model).lower() or "mixtral" in str(ai_model).lower() or "qwen" in str(ai_model).lower() or "gpt-oss" in str(ai_model).lower() or "groq" in str(ai_model).lower()):
                ai_provider = "groq"
                api_key = cfg.get("groq_api_key") or os.environ.get("GROQ_API_KEY", "")
                chosen_model = ai_model if any(m in str(ai_model) for m in ["gpt-oss", "qwen"]) else "openai/gpt-oss-120b"
            elif ai_model and ("gpt-4" in str(ai_model).lower() or "gpt-3.5" in str(ai_model).lower() or "o1" in str(ai_model).lower() or "o3" in str(ai_model).lower()):
                ai_provider = "openai"
                api_key = cfg.get("openai_api_key") or os.environ.get("OPENAI_API_KEY", "")
                chosen_model = ai_model
            elif ai_model and "gemini" in str(ai_model).lower():
                ai_provider = "gemini"
                api_key = cfg.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY", "")
                chosen_model = ai_model
            else:
                ai_provider = cfg.get("default_llm_provider", "gemini")
                if ai_provider == "groq" and cfg.get("groq_api_key"):
                    api_key = cfg.get("groq_api_key")
                    chosen_model = ai_model if any(m in str(ai_model) for m in ["gpt-oss", "qwen"]) else "openai/gpt-oss-120b"
                elif ai_provider == "openai" and cfg.get("openai_api_key"):
                    api_key = cfg.get("openai_api_key")
                    chosen_model = "gpt-4o-mini"
                else:
                    ai_provider = "gemini"
                    api_key = cfg.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY", "")
                    chosen_model = ai_model or "gemini-3.5-flash-lite"

            prod_mode = "single" if cast_mode == "solo" else "multi"

            direct_res = ai_dir.direct_story(
                blocks=blocks,
                voices=voices,
                provider=ai_provider,
                api_key=api_key,
                model=chosen_model,
                split_dialogue=split_quotes,
                cast_voices=(cast_mode == "multi"),
                add_emotions=acting_tags,
                default_narrator_voice=chosen_voice,
                progress_callback=progress_callback,
                acting_intensity=acting_intensity,
                analysis_temperature=analysis_temperature,
                production_mode=prod_mode,
                existing_characters=master_cast
            )

            if direct_res.get("ok"):
                blocks = direct_res.get("blocks", blocks)
                new_chars = direct_res.get("characters", [])
                if new_chars:
                    characters = new_chars
                    # Automatically synchronize new characters to the Unified Master Cast
                    if folder_id:
                        self.add_characters_to_master_cast(folder_id, new_chars)
            else:
                print(f"[ProjectManager] AI direct warning: {direct_res.get('error')}. Retaining blocks with rule-based dialogue.")

        if save_as_folder_default and folder_id:
            self.save_folder_director_settings(folder_id, {
                "cast_mode": cast_mode,
                "ai_model": ai_model,
                "split_quotes": split_quotes,
                "acting_tags": acting_tags,
                "acting_intensity": acting_intensity,
                "analysis_temperature": analysis_temperature,
                "default_voice": chosen_voice
            })

        # Update and save project
        proj["blocks"] = blocks
        proj["characters"] = characters
        proj["is_stub"] = False
        proj["word_count"] = ch_data.get("word_count", len(raw_text.split()))
        proj["estimated_minutes"] = ch_data.get("estimated_minutes", round(len(raw_text.split()) / 150.0, 1))
        proj["updated_at"] = time.time()
        self.save_project(proj, project_id)

        return {
            "ok": True,
            "project": proj,
            "blocks_count": len(blocks),
            "characters": characters,
            "word_count": proj["word_count"],
            "estimated_minutes": proj["estimated_minutes"]
        }

    def save_folder(self, folder_data: Dict, folder_id: Optional[str] = None) -> str:
        import uuid
        import time
        fid = folder_id or folder_data.get("id")
        if not fid:
            fid = f"folder_{uuid.uuid4().hex[:8]}"
            folder_data["id"] = fid

        folder_data["updated_at"] = time.time()
        fp = self.get_folder_path(fid)
        if fp.exists() and "owner_id" not in folder_data:
            try:
                with open(fp, "r", encoding="utf-8") as exf:
                    ex_d = json.load(exf)
                    if ex_d.get("owner_id"):
                        folder_data["owner_id"] = ex_d["owner_id"]
            except Exception:
                pass
        with open(fp, "w", encoding="utf-8") as f:
            json.dump(folder_data, f, indent=2, ensure_ascii=False)
        return fid

    def delete_folder(self, folder_id: str, delete_chapters: bool = False) -> bool:
        folder = self.get_folder(folder_id)
        if not folder:
            return False

        # If this is a parent series with subfolders, delete child subfolders recursively
        for sf in folder.get("subfolders", []):
            self.delete_folder(sf["id"], delete_chapters=delete_chapters)

        for ch in folder.get("chapters", []):
            p_data = self.get_project(ch["id"])
            if not p_data:
                continue
            # If explicit delete_chapters requested OR if chapter is an unimported stub card, delete it completely
            if delete_chapters or p_data.get("is_stub"):
                self.delete_project(ch["id"])
            else:
                p_data.pop("folder_id", None)
                p_data.pop("parent_series_id", None)
                self.save_project(p_data, ch["id"])

        fp = self.get_folder_path(folder_id)
        if fp.exists():
            fp.unlink()
            return True
        return False

    def add_project_to_folder(self, folder_id: str, project_id: str, chapter_index: Optional[int] = None) -> bool:
        fp = self.get_folder_path(folder_id)
        if not fp.exists():
            return False
        with open(fp, "r", encoding="utf-8") as f:
            f_data = json.load(f)

        p_data = self.get_project(project_id)
        if not p_data:
            return False

        p_data["folder_id"] = folder_id
        self.save_project(p_data, project_id)

        ch_order = f_data.get("chapter_order", [])
        if project_id in ch_order:
            ch_order.remove(project_id)

        if chapter_index is not None and 0 <= chapter_index <= len(ch_order):
            ch_order.insert(chapter_index, project_id)
        else:
            ch_order.append(project_id)
        f_data["chapter_order"] = ch_order

        # Merge project characters into folder Master Cast (dedup by name)
        existing_chars = f_data.get("characters", [])
        existing_names = {c["name"].strip().lower() for c in existing_chars if c.get("name")}
        for pc in p_data.get("characters", []):
            if pc.get("name") and pc["name"].strip().lower() not in existing_names:
                existing_chars.append(dict(pc))
                existing_names.add(pc["name"].strip().lower())
        f_data["characters"] = existing_chars

        self.save_folder(f_data, folder_id)
        if chapter_index is None:
            try:
                self.sort_folder_chapters(folder_id)
            except Exception:
                pass
        return True

    def remove_project_from_folder(self, folder_id: str, project_id: str) -> bool:
        fp = self.get_folder_path(folder_id)
        if fp.exists():
            with open(fp, "r", encoding="utf-8") as f:
                f_data = json.load(f)
            ch_order = f_data.get("chapter_order", [])
            if project_id in ch_order:
                ch_order.remove(project_id)
                f_data["chapter_order"] = ch_order
                self.save_folder(f_data, folder_id)

        p_data = self.get_project(project_id)
        if p_data:
            p_data.pop("folder_id", None)
            self.save_project(p_data, project_id)
            return True
        return False

    def reorder_folder_chapters(self, folder_id: str, chapter_ids: List[str]) -> bool:
        fp = self.get_folder_path(folder_id)
        if not fp.exists():
            return False
        with open(fp, "r", encoding="utf-8") as f:
            f_data = json.load(f)
        f_data["chapter_order"] = chapter_ids
        self.save_folder(f_data, folder_id)
        return True

    def update_folder_master_cast(self, folder_id: str, characters: List[Dict], sync_to_chapters: bool = True, mode: str = "replace") -> bool:
        fp = self.get_folder_path(folder_id)
        if not fp.exists():
            return False
        with open(fp, "r", encoding="utf-8") as f:
            f_data = json.load(f)

        if mode == "merge":
            existing = f_data.get("characters") or f_data.get("master_cast") or []
            existing_map = {c.get("name", "").strip().lower(): c for c in existing if c.get("name")}
            for nc in characters:
                k = nc.get("name", "").strip().lower()
                if k in existing_map:
                    existing_map[k].update(nc)
                else:
                    existing.append(dict(nc))
            final_chars = existing
        else:
            final_chars = characters

        f_data["characters"] = final_chars
        f_data["master_cast"] = final_chars
        self.save_folder(f_data, folder_id)

        # Bubble up to parent folder if exists
        parent_id = f_data.get("parent_id")
        if parent_id:
            p_fp = self.get_folder_path(parent_id)
            if p_fp.exists():
                try:
                    with open(p_fp, "r", encoding="utf-8") as pf:
                        p_data = json.load(pf)
                    p_existing = p_data.get("characters") or p_data.get("master_cast") or []
                    p_map = {c.get("name", "").strip().lower(): c for c in p_existing if c.get("name")}
                    for nc in final_chars:
                        k = nc.get("name", "").strip().lower()
                        if k in p_map:
                            p_map[k].update(nc)
                        else:
                            p_existing.append(dict(nc))
                    p_data["characters"] = p_existing
                    p_data["master_cast"] = p_existing
                    self.save_folder(p_data, parent_id)
                except Exception:
                    pass

        if sync_to_chapters:
            ch_order = f_data.get("chapter_order", [])
            cast_by_name = {c["name"].strip().lower(): c for c in final_chars if c.get("name")}
            for cid in ch_order:
                proj = self.get_project(cid)
                if not proj:
                    continue
                p_chars = proj.get("characters", [])
                p_names = {c["name"].strip().lower() for c in p_chars if c.get("name")}
                for pc in p_chars:
                    k = pc.get("name", "").strip().lower()
                    if k in cast_by_name:
                        mc = cast_by_name[k]
                        if mc.get("assigned_voice_id"):
                            pc["assigned_voice_id"] = mc["assigned_voice_id"]
                        if mc.get("voice_id"):
                            pc["voice_id"] = mc["voice_id"]
                        if mc.get("persona"):
                            pc["persona"] = mc["persona"]
                        if "default_emotion_tag" in mc:
                            pc["default_emotion_tag"] = mc["default_emotion_tag"]
                        if mc.get("reference_audio"):
                            pc["reference_audio"] = mc["reference_audio"]
                        if mc.get("reference_text"):
                            pc["reference_text"] = mc["reference_text"]
                for mc in final_chars:
                    k = mc.get("name", "").strip().lower()
                    if k and k not in p_names:
                        p_chars.append(dict(mc))
                proj["characters"] = p_chars
                self.save_project(proj, cid)
        return True

    def remove_character_from_master_cast(self, folder_id: str, char_id_or_name: str, remove_from_chapters: bool = False) -> bool:
        fp = self.get_folder_path(folder_id)
        if not fp.exists():
            return False
        with open(fp, "r", encoding="utf-8") as f:
            f_data = json.load(f)

        target = (char_id_or_name or "").strip().lower()
        existing = f_data.get("characters") or f_data.get("master_cast") or []
        new_chars = [c for c in existing if c.get("id") != char_id_or_name and c.get("name", "").strip().lower() != target]
        f_data["characters"] = new_chars
        f_data["master_cast"] = new_chars
        self.save_folder(f_data, folder_id)

        # Bubble up to parent folder if exists
        parent_id = f_data.get("parent_id")
        if parent_id:
            p_fp = self.get_folder_path(parent_id)
            if p_fp.exists():
                try:
                    with open(p_fp, "r", encoding="utf-8") as pf:
                        p_data = json.load(pf)
                    p_existing = p_data.get("characters") or p_data.get("master_cast") or []
                    p_data["characters"] = [c for c in p_existing if c.get("id") != char_id_or_name and c.get("name", "").strip().lower() != target]
                    p_data["master_cast"] = p_data["characters"]
                    self.save_folder(p_data, parent_id)
                except Exception:
                    pass

        if remove_from_chapters:
            ch_order = f_data.get("chapter_order", [])
            for cid in ch_order:
                proj = self.get_project(cid)
                if not proj:
                    continue
                p_chars = proj.get("characters", [])
                p_new = [c for c in p_chars if c.get("id") != char_id_or_name and c.get("name", "").strip().lower() != target]
                if len(p_new) != len(p_chars):
                    proj["characters"] = p_new
                    self.save_project(proj, cid)
        return True

    @staticmethod
    def parse_chapter_info(title: str, explicit_num=None) -> Dict[str, Any]:
        """
        Parses title for chapter numbers, roman numerals, word numbers, or front/back matter keywords.
        Returns a dict with 'rank', 'is_front_matter', 'is_back_matter', 'chapter_label', and 'parsed_number'.
        """
        WORD_NUMS = {
            "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
            "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
            "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
            "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20
        }
        ROMAN_NUMS = {
            "i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7,
            "viii": 8, "ix": 9, "x": 10, "xi": 11, "xii": 12, "xiii": 13,
            "xiv": 14, "xv": 15, "xvi": 16, "xvii": 17, "xviii": 18, "xix": 19, "xx": 20
        }
        FRONT_MATTER_SCORES = {
            "cover": -50, "title": -40, "copyright": -30, "dedication": -25,
            "acknowledgments": -20, "acknowledgement": -20, "foreword": -15,
            "preface": -10, "prologue": -5, "introduction": -4, "intro": -4
        }
        BACK_MATTER_SCORES = {
            "epilogue": 10010, "afterword": 10020, "conclusion": 10030,
            "appendix": 10040, "glossary": 10050, "index": 10060, "about the author": 10070
        }

        t = (title or "").lower()

        # 1. Front matter
        for kw, score in FRONT_MATTER_SCORES.items():
            if re.search(r'\b' + re.escape(kw) + r'\b', t):
                lbl = "Legal" if kw == "copyright" else kw.capitalize()
                return {
                    "rank": score,
                    "is_front_matter": True,
                    "is_back_matter": False,
                    "chapter_label": lbl,
                    "parsed_number": None
                }

        # 2. Back matter
        for kw, score in BACK_MATTER_SCORES.items():
            if re.search(r'\b' + re.escape(kw) + r'\b', t):
                return {
                    "rank": score,
                    "is_front_matter": False,
                    "is_back_matter": True,
                    "chapter_label": kw.capitalize(),
                    "parsed_number": None
                }

        # 3. "Chapter X", "Lesson X", "Act X", "Ch X", "Part X"
        m = re.search(r'\b(?:chapter|lesson|act|ch|part|episode|ep)\.?\s*([a-z0-9]+)', t)
        if m:
            token = m.group(1).lower()
            num = None
            if token.isdigit():
                num = int(token)
            elif token in WORD_NUMS:
                num = WORD_NUMS[token]
            elif token in ROMAN_NUMS:
                num = ROMAN_NUMS[token]
            if num is not None:
                return {
                    "rank": num,
                    "is_front_matter": False,
                    "is_back_matter": False,
                    "chapter_label": f"Ch. {num}",
                    "parsed_number": num
                }

        # 4. Standalone number in title
        m2 = re.search(r'\b(\d+)\b', t)
        if m2:
            num = int(m2.group(1))
            return {
                "rank": num,
                "is_front_matter": False,
                "is_back_matter": False,
                "chapter_label": f"Ch. {num}",
                "parsed_number": num
            }

        # 5. Explicit fallback
        if explicit_num is not None and isinstance(explicit_num, (int, float)):
            num = int(explicit_num)
            return {
                "rank": num,
                "is_front_matter": False,
                "is_back_matter": False,
                "chapter_label": f"Ch. {num}",
                "parsed_number": num
            }

        return {
            "rank": 500,
            "is_front_matter": False,
            "is_back_matter": False,
            "chapter_label": "Story",
            "parsed_number": None
        }

    def sort_folder_chapters(self, folder_id: str) -> List[str]:
        """
        Sorts all chapters in a folder in natural book order (Front Matter -> Ch 1..N -> Back Matter).
        Updates each project's chapter_number and the folder's chapter_order.
        """
        fp = self.get_folder_path(folder_id)
        if not fp.exists():
            return []
        with open(fp, "r", encoding="utf-8") as f:
            f_data = json.load(f)

        all_projects = {p["id"]: p for p in self.list_projects()}
        folder_projs = []
        for pid, pdata in all_projects.items():
            if pdata.get("folder_id") == folder_id:
                folder_projs.append(pdata)

        if not folder_projs:
            return []

        def _sort_key(p):
            info = ProjectManager.parse_chapter_info(p.get("title", ""), p.get("chapter_number"))
            return (info["rank"], p.get("created_at") or 0, p.get("title") or "")

        sorted_projs = sorted(folder_projs, key=_sort_key)
        new_order = []

        numbered_count = 1
        for p in sorted_projs:
            pid = p["id"]
            new_order.append(pid)
            info = ProjectManager.parse_chapter_info(p.get("title", ""), p.get("chapter_number"))
            full_p = self.get_project(pid)
            if full_p:
                if info.get("parsed_number") is not None:
                    full_p["chapter_number"] = info["parsed_number"]
                elif info.get("is_front_matter"):
                    full_p["chapter_number"] = None
                else:
                    full_p["chapter_number"] = numbered_count
                    numbered_count += 1
                self.save_project(full_p, pid)

        f_data["chapter_order"] = new_order
        self.save_folder(f_data, folder_id)
        return new_order

