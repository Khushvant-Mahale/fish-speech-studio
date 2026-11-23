import os
import re
import json
import time
import hashlib
import urllib.request
import urllib.error
from typing import List, Dict, Any, Optional

from core.fish_engine import FishEngine

class AIDirector:
    """
    Intelligent LLM-powered Story Director & Character Casting Engine.
    Supports Google Gemini (2.5 Flash / 2.5 Flash-Lite / 2.0 Flash), Groq, OpenAI, and Local Ollama.
    """

    DEFAULT_MODELS = {
        "gemini": "gemini-2.5-flash",
        "groq": "openai/gpt-oss-120b",
        "openai": "gpt-4o-mini",
        "ollama": "llama3.2"
    }

    @staticmethod
    def parse_llm_json(raw_text: str) -> Any:
        """Robustly extracts and parses JSON from LLM output, handling markdown fences, brackets and commentary."""
        if not raw_text or not raw_text.strip():
            raise ValueError("Empty response from LLM.")
        txt = raw_text.strip()
        # 1. Search for markdown ```json ... ``` blocks
        if "```" in txt:
            parts = txt.split("```")
            for part in parts:
                cleaned = part.strip()
                if cleaned.startswith("json"):
                    cleaned = cleaned[4:].strip()
                if (cleaned.startswith("{") and cleaned.endswith("}")) or (cleaned.startswith("[") and cleaned.endswith("]")):
                    try:
                        return json.loads(cleaned)
                    except Exception:
                        pass
        # 2. Extract outer matching braces or brackets
        b_brace = txt.find("{")
        e_brace = txt.rfind("}")
        b_brack = txt.find("[")
        e_brack = txt.rfind("]")

        # If bracket appears first (or no brace), try bracket block
        if b_brack != -1 and e_brack > b_brack and (b_brace == -1 or b_brack < b_brace):
            try:
                return json.loads(txt[b_brack:e_brack+1])
            except Exception:
                pass

        if b_brace != -1 and e_brace > b_brace:
            try:
                return json.loads(txt[b_brace:e_brace+1])
            except Exception:
                pass

        if b_brack != -1 and e_brack > b_brack:
            try:
                return json.loads(txt[b_brack:e_brack+1])
            except Exception:
                pass

        # 3. Truncated array auto-recovery: if txt starts with '[' but lacks ']', find last valid '}' and close it
        if b_brack != -1 and (e_brack == -1 or e_brack < b_brack):
            last_close_brace = txt.rfind("}")
            if last_close_brace > b_brack:
                try:
                    repaired = txt[b_brack:last_close_brace + 1].strip().rstrip(",") + "]"
                    return json.loads(repaired)
                except Exception:
                    pass

        # 4. Direct clean fallback
        clean = txt.strip("`").removeprefix("json").strip()
        return json.loads(clean)

    @staticmethod
    def format_voice_library_prompt(voices: List[Dict[str, Any]]) -> str:
        """Formats available voices into a compact description table for the LLM."""
        lines = []
        for v in voices:
            vid = v.get("id") or v.get("voice_id", "")
            name = v.get("name") or v.get("title", vid)
            gender = v.get("gender") or "neutral"
            desc = v.get("description") or v.get("timbre") or ", ".join(v.get("tags", [])) or "Expressive narrator"
            lines.append(f'- ID: "{vid}" | Name: "{name}" | Gender: {gender} | Persona: {desc}')
        return "\n".join(lines)

    DIALOGUE_INTRO_VERBS = {
        "said", "asked", "replied", "whispered", "screamed", "cried", "shouted",
        "murmured", "yelled", "muttered", "growled", "roared", "barked", "snapped",
        "gasped", "stammered", "stuttered", "whined", "begged", "demanded", "inquired",
        "commanded", "ordered", "called", "bellowed", "cheered", "laughed", "chuckled",
        "grunted", "snorted", "sneered", "taunted", "hissed", "sighed", "agreed", "added",
        "continued", "concluded", "interrupted", "suggested", "urged", "warned"
    }

    CONNECTORS_BEFORE_SCARE_QUOTES = {
        "to", "a", "an", "the", "of", "in", "for", "with", "into", "about",
        "like", "as", "called", "named", "termed", "labeled", "dubbed",
        "their", "his", "her", "my", "our", "its", "or", "and", "meaning"
    }

    @classmethod
    def is_dialogue_quote(cls, text: str, start: int, end: int) -> bool:
        """
        Determines whether a quoted string is direct spoken dialogue vs
        an in-sentence scare quote, idiom, book/movie title, or term (e.g. ask everyone to "chip in.").
        """
        raw_quote = text[start:end]
        inner = raw_quote.strip('“"«‘’”»\'').strip()
        if not inner:
            return False

        prefix = text[:start].rstrip()

        # 1. At the very beginning of the string/paragraph -> Spoken dialogue
        if not prefix:
            return True

        last_char = prefix[-1]

        # 2. Check if preceded by sentence-ending punctuation (. ! ? — --)
        if last_char in ('.', '!', '?', '—') or prefix.endswith('--'):
            return True

        # 3. Check if preceded by comma (,) or colon (:)
        if last_char in (',', ':'):
            return True

        # 4. If prefix does NOT end with punctuation (e.g. ends with 'to', 'called', 'the'):
        words_before = prefix.split()
        if words_before:
            last_word = re.sub(r'[^A-Za-z]', '', words_before[-1]).lower()
            if last_word in cls.CONNECTORS_BEFORE_SCARE_QUOTES:
                return False

        # 5. If inner starts with lowercase letter (e.g. "chip in.", "rat race") without a preceding comma
        if inner[0].islower() and last_char not in (',', ':'):
            return False

        # 6. If it's very short (1-3 words) and lacks sentence structure / punctuation, and preceded by word
        inner_words = inner.split()
        if len(inner_words) <= 3 and not re.search(r'[.!?]$', inner) and last_char not in (',', ':'):
            return False

        return True

    @classmethod
    def extract_quote_segments(cls, text: str) -> List[tuple]:
        """
        Extracts quoted dialogue segments and narrative segments from text.
        Returns a list of tuples: (is_dialogue: bool, segment_text: str)
        In-sentence scare quotes, titles, and idioms (e.g. ask everyone to "chip in.")
        are preserved as part of the narrative segment so they are not cut out!
        """
        pattern = re.compile(
            r'('
            r'“[^”\r\n]*”'
            r'|"[^"\r\n]*"'
            r'|«[^»\r\n]*»'
            r'|‘(?:[^’\r\n]|(?<=\w)’(?=\w))*’'
            r'|\'(?:[^\'\r\n]|(?<=\w)\'(?=\w))+\''
            r')'
        )
        segments = []
        last_end = 0
        for m in pattern.finditer(text):
            start, end = m.span()
            q = m.group(0).strip()

            # Check if this quote is actual dialogue or in-sentence scare quote
            if not cls.is_dialogue_quote(text, start, end):
                continue

            if start > last_end:
                narr = text[last_end:start].strip()
                if narr:
                    segments.append((False, narr))
            if q:
                segments.append((True, q))
            last_end = end

        if last_end < len(text):
            narr = text[last_end:].strip()
            if narr:
                segments.append((False, narr))
        return segments

    ADVERB_TAG_MAP = {
        "excitedly": "[excited][cheerful]",
        "brightly": "[cheerful]",
        "happily": "[cheerful]",
        "eagerly": "[eager][fast]",
        "cheerfully": "[cheerful]",
        "angrily": "[angry]",
        "fiercely": "[fierce][angry]",
        "furiously": "[furious][shouting]",
        "savagely": "[angry][growl]",
        "coldly": "[cold][sneer]",
        "grimly": "[grim][softly]",
        "sternly": "[stern][quiet authority]",
        "flatly": "[flat][calm]",
        "quietly": "[softly]",
        "softly": "[softly]",
        "gently": "[tender][softly]",
        "nervously": "[nervous][trembling voice]",
        "anxiously": "[anxious]",
        "timidly": "[timid][softly]",
        "fearfully": "[terrified][trembling voice]",
        "indignantly": "[indignant][sarcastic]",
        "scornfully": "[sarcastic][mocking tone]",
        "mockingly": "[mocking tone][sneer]",
        "derisively": "[sarcastic]",
        "wearily": "[sigh][tired]",
        "tiredly": "[sigh][tired]",
        "earnestly": "[earnest][sincere]",
        "pleadingly": "[pleading][desperate]",
        "desperately": "[desperate]",
        "evil grin": "[sinister][mocking tone]",
        "grinned": "[chuckle][cheerful]",
        "smiled": "[cheerful]",
        "chuckled": "[chuckle]",
        "laughed": "[laughs]",
        "sighed": "[sigh]",
        "gasped": "[gasp]",
        "groaned": "[groan]",
        "shouted": "[shouting]",
        "yelled": "[yell]",
        "screamed": "[screaming]",
        "bellowed": "[bellow][loud]",
        "roared": "[roaring]",
        "whispered": "[whisper]",
        "murmured": "[murmur]",
        "muttered": "[mutter][grumble]",
        "hissed": "[hiss]",
        "sneered": "[sneer][cold]",
        "drawled": "[drawling][cold]",
        "dismissively": "[dismissive][cold]",
        "contempt": "[contemptuous][sneer]",
        "impatience": "[impatient][softly]",
        "impatiently": "[impatient][softly]",
        "urgently": "[urgent][fast]",
        "defiantly": "[defiant]"
    }

    @classmethod
    def extract_acting_tag_from_context(cls, text: str, punctuation: str = "") -> str:
        """Derives a rich, expressive Fish Speech S2 acting tag from surrounding text, verbs, or punctuation."""
        txt_l = text.lower()
        for phrase, tag in cls.ADVERB_TAG_MAP.items():
            if phrase in txt_l:
                return tag
        if "!" in punctuation:
            return "[excited]"
        elif "?" in punctuation:
            return "[curious]"
        elif "…" in punctuation or "..." in punctuation or "—" in punctuation:
            return "[hesitant]"
        return "[expressive]"

    @classmethod
    def find_matching_character(cls, tag_text: str, char_map: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Robust multi-stage character matcher. Resolves full names, honorifics (Mr./Mrs. Weasley),
        speech verb proximity ('said Fred', 'said Snape'), first names, and unique last names.
        """
        if not tag_text:
            return None
        tag_clean = tag_text.lower()

        # Deduplicate objects across all aliases in char_map
        unique_chars = list({c.get("id", c.get("name")): c for c in char_map.values() if c and (c.get("name") or "").lower() != "narrator"}.values())

        # 1. Exact full name match (longest full name wins)
        best_match = None
        best_len = 0
        for cobj in unique_chars:
            char_full = (cobj.get("name") or "").lower()
            if char_full and re.search(rf'\b{re.escape(char_full)}\b', tag_clean, re.IGNORECASE):
                if len(char_full) > best_len:
                    best_match = cobj
                    best_len = len(char_full)
        if best_match:
            return best_match

        # 2. Check Honorifics: Mr. / Mrs. / Miss / Professor / Dr. with household/persona disambiguation
        candidates = []
        for cobj in unique_chars:
            name_parts = (cobj.get("name") or "").split()
            if len(name_parts) >= 2:
                last_name = name_parts[-1].lower()
                gender = cobj.get("gender", "").lower()
                if re.search(rf'\bmr\.?\s+{re.escape(last_name)}\b', tag_clean, re.IGNORECASE) and gender in ("male", ""):
                    candidates.append((cobj, "male"))
                elif re.search(rf'\bmrs\.?\s+{re.escape(last_name)}\b', tag_clean, re.IGNORECASE) and gender in ("female", ""):
                    candidates.append((cobj, "female"))
                elif re.search(rf'\bmiss\.?\s+{re.escape(last_name)}\b', tag_clean, re.IGNORECASE) and gender in ("female", ""):
                    candidates.append((cobj, "female"))
                elif re.search(rf'\bprof(?:essor)?\.?\s+{re.escape(last_name)}\b', tag_clean, re.IGNORECASE):
                    candidates.append((cobj, "prof"))

        if candidates:
            if len(candidates) == 1:
                return candidates[0][0]
            # Disambiguate when multiple members share last name (e.g., Arthur vs Fred/George for Mr. Weasley)
            for cobj, role in candidates:
                persona = cobj.get("persona", "").lower()
                if any(k in persona for k in ["father", "head", "parent", "senior", "adult", "husband", "mother", "matriarch"]):
                    return cobj
            return candidates[0][0]

        # 3. Speech verb proximity match (e.g. "said Fred", "Harry asked", "said Snape", "Snape sneered")
        speech_verbs = r'(?:said|asked|replied|cried|whispered|shouted|yelled|gasped|muttered|murmured|snapped|laughed|bellowed|called|urged|added|warned|inquired|stammered|repeated|screamed|hissed|demanded|chuckled|sighed|grunted|sneered)'
        for cobj in unique_chars:
            name_parts = (cobj.get("name") or "").split()
            names_to_check = [name_parts[0].lower()]
            if len(name_parts) >= 2:
                names_to_check.append(name_parts[-1].lower())
            for n in names_to_check:
                if len(n) < 3:
                    continue
                pat1 = rf'\b{speech_verbs}\s+(?:to\s+[a-z]+\s+)?(?:[a-z]+ly\s+)?{re.escape(n)}\b'
                pat2 = rf'\b{re.escape(n)}\s+(?:[a-z]+ly\s+)?{speech_verbs}\b'
                if re.search(pat1, tag_clean, re.IGNORECASE) or re.search(pat2, tag_clean, re.IGNORECASE):
                    return cobj

        # 4. First name match as fallback (longest first name wins to prevent short prefix collisions)
        for cobj in unique_chars:
            name_parts = (cobj.get("name") or "").split()
            first_name = name_parts[0].lower()
            if len(first_name) >= 3 and re.search(rf'\b{re.escape(first_name)}\b', tag_clean, re.IGNORECASE):
                if len(first_name) > best_len:
                    best_match = cobj
                    best_len = len(first_name)
        if best_match:
            return best_match

        # 5. Unique Last name match (e.g., "Snape" when cast is "Severus Snape")
        last_name_counts = {}
        for cobj in unique_chars:
            parts = (cobj.get("name") or "").split()
            if len(parts) >= 2:
                ln = parts[-1].lower()
                last_name_counts[ln] = last_name_counts.get(ln, 0) + 1
        for cobj in unique_chars:
            parts = (cobj.get("name") or "").split()
            if len(parts) >= 2:
                ln = parts[-1].lower()
                if last_name_counts.get(ln, 0) == 1 and len(ln) >= 4:
                    if re.search(rf'\b{re.escape(ln)}\b', tag_clean, re.IGNORECASE):
                        return cobj
        return None

    @classmethod
    def rule_based_direct_blocks(
        cls,
        chunk: List[Dict[str, Any]],
        char_map: Dict[str, Any],
        narrator_char: Dict[str, Any],
        is_single_narrator: bool = False,
        acting_intensity: str = "balanced"
    ) -> List[Dict[str, Any]]:
        """
        Robust offline rule-based dialogue attribution and expressive acting tag synthesizer.
        Used as high-fidelity fallback when LLM API rate limits are reached.
        """
        narr_name = narrator_char.get("name", "Narrator")
        narr_id = narrator_char.get("id", "char_narrator")
        narr_vid = narrator_char.get("assigned_voice_id") or narrator_char.get("voice_id", "")

        result = []
        last_speaker_obj = None

        for idx, b in enumerate(chunk):
            raw_text = (b.get("text") or "").strip()
            if not raw_text:
                continue

            segments = cls.extract_quote_segments(raw_text)
            if not any(s[0] for s in segments):
                spk_in_narr = cls.find_matching_character(raw_text, char_map)
                if spk_in_narr:
                    last_speaker_obj = spk_in_narr

                result.append({
                    "id": b.get("id"),
                    "speaker": narr_name,
                    "character_id": narr_id,
                    "voice_id": narr_vid,
                    "text": raw_text,
                    "emotion_tag": None,
                    "pause_after": b.get("pause_after", 0.6)
                })
                continue

            for is_quote, seg_text in segments:
                seg_text = seg_text.strip()
                if not seg_text:
                    continue

                if not is_quote:
                    tag_spk = cls.find_matching_character(seg_text, char_map)
                    if tag_spk:
                        last_speaker_obj = tag_spk
                    result.append({
                        "id": b.get("id"),
                        "speaker": narr_name,
                        "character_id": narr_id,
                        "voice_id": narr_vid,
                        "text": seg_text,
                        "emotion_tag": None,
                        "pause_after": 0.5
                    })
                else:
                    assigned_spk = None
                    if idx + 1 < len(chunk):
                        assigned_spk = cls.find_matching_character(chunk[idx + 1].get("text", ""), char_map)
                    if not assigned_spk and idx > 0:
                        assigned_spk = cls.find_matching_character(chunk[idx - 1].get("text", ""), char_map)
                    if not assigned_spk and last_speaker_obj:
                        assigned_spk = last_speaker_obj
                    if not assigned_spk:
                        assigned_spk = next((c for c in char_map.values() if c.get("name", "").lower() != "narrator"), narrator_char)

                    spk_name = assigned_spk.get("name", narr_name)
                    cid = assigned_spk.get("id", narr_id)
                    vid = narr_vid if is_single_narrator else (assigned_spk.get("assigned_voice_id") or assigned_spk.get("voice_id", narr_vid))

                    surrounding = ""
                    if idx + 1 < len(chunk):
                        surrounding += " " + chunk[idx + 1].get("text", "")
                    if idx > 0:
                        surrounding += " " + chunk[idx - 1].get("text", "")
                    tag = cls.extract_acting_tag_from_context(surrounding, seg_text)
                    if acting_intensity == "subtle" and tag not in ("[shouting]", "[screaming]", "[whisper]", "[crying]"):
                        tag = None

                    result.append({
                        "id": b.get("id"),
                        "speaker": spk_name,
                        "character_id": cid,
                        "voice_id": vid,
                        "text": seg_text,
                        "emotion_tag": tag,
                        "pause_after": 0.4
                    })
                    last_speaker_obj = assigned_spk

        return result

    @classmethod
    def sanitize_and_split_dialogue(
        cls,
        blocks: List[Dict[str, Any]],
        narrator_char: Dict[str, Any],
        char_map: Dict[str, Any],
        is_single_narrator: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Guarantees that character dialogue is strictly separated from narrative text.
        Any spoken dialogue enclosed within quotation marks is isolated into distinct blocks.
        Narrative lead-ins, dialogue attribution tags (e.g., 'said rich dad.', 'he whispered.'),
        or action beats outside quotation marks are placed in separate Narrator speech blocks.
        Uses bidirectional attribution resolution so preceding quotes are accurately attributed
        to trailing speaker tags ('...' said rich dad.).
        """
        quote_detect = re.compile(r'[\"“«‘\']')
        clean_blocks = []

        narr_name = narrator_char.get("name", "Narrator")
        narr_id = narrator_char.get("id", "char_narrator")
        narr_vid = narrator_char.get("assigned_voice_id") or narrator_char.get("voice_id", "")

        for b in blocks:
            spk = b.get("speaker", narr_name)
            is_narr = (spk.lower() == "narrator") or ("narrator" in spk.lower())
            text = (b.get("text") or "").strip()
            if not text:
                continue

            # If block has NO quotation marks
            if not quote_detect.search(text):
                if is_narr:
                    if is_single_narrator:
                        b["voice_id"] = narr_vid
                    clean_blocks.append(b)
                else:
                    # Check if this is an unquoted dialogue tag mistakenly assigned to character
                    tag_match = re.match(r'^(?:he|she|they|[A-Z][a-z]+)\s+(?:said|asked|replied|yelled|whispered|laughed|chuckled|added|thought|smiled|answered)[\.,]?$', text, re.IGNORECASE)
                    if tag_match:
                        clean_blocks.append({
                            **b,
                            "speaker": narr_name,
                            "character_id": narr_id,
                            "voice_id": narr_vid,
                            "emotion_tag": None
                        })
                    else:
                        if is_single_narrator:
                            b["voice_id"] = narr_vid
                        clean_blocks.append(b)
                continue

            # Block CONTAINS quotation marks!
            segments = cls.extract_quote_segments(text)

            # If block is ALREADY cleanly assigned to a character by the AI Director (not Narrator)
            # and consists purely of quoted dialogue without dangling narrative text, preserve it!
            if not is_narr and len(segments) == 1 and segments[0][0]:
                if is_single_narrator:
                    b["voice_id"] = narr_vid
                clean_blocks.append(b)
                continue

            # If block contains only in-sentence scare quotes/idioms (no actual dialogue quotes)
            if not any(s[0] for s in segments):
                if is_single_narrator:
                    b["voice_id"] = narr_vid
                clean_blocks.append(b)
                continue

            engine = b.get("engine", "fish_s2")
            char_emotion = b.get("emotion_tag")

            # Bidirectional speaker resolution for segments within this block
            resolved_speakers = [None] * len(segments)

            for idx, (is_q, seg_txt) in enumerate(segments):
                if not is_q:
                    # Narrative segment: check for trailing or leading attribution
                    sub_parts = re.split(r'(?<=[.!?])\s+', seg_txt)
                    first_clause = sub_parts[0]
                    last_clause = sub_parts[-1]

                    # 1. Trailing attribution: assigns speaker to preceding quote (e.g. '"..." said rich dad.')
                    char_prev = cls.find_matching_character(first_clause, char_map)
                    if char_prev and idx > 0 and segments[idx - 1][0] and resolved_speakers[idx - 1] is None:
                        resolved_speakers[idx - 1] = char_prev

                    # 2. Leading attribution: assigns speaker to following quote (e.g. 'Mike asked, "..."')
                    char_next = cls.find_matching_character(last_clause, char_map)
                    if char_next and idx + 1 < len(segments) and segments[idx + 1][0] and resolved_speakers[idx + 1] is None:
                        resolved_speakers[idx + 1] = char_next

            # Pre-existing character of the block if not narrator
            block_char = None
            if not is_narr:
                block_char = cls.find_matching_character(spk, char_map)

            last_speaking_char = None

            for idx, (is_quote, seg_text) in enumerate(segments):
                seg_text = seg_text.strip()
                if not seg_text:
                    continue

                if is_quote:
                    # Spoken character dialogue
                    assigned_char = resolved_speakers[idx] or block_char or last_speaking_char
                    if not assigned_char and is_narr:
                        # Attempt to find speaker in any narrative segment in this block
                        for other_is_q, other_txt in segments:
                            if not other_is_q:
                                c = cls.find_matching_character(other_txt, char_map)
                                if c:
                                    assigned_char = c
                                    break

                    if assigned_char:
                        quote_spk = assigned_char["name"]
                        quote_cid = assigned_char["id"]
                        quote_vid = narr_vid if is_single_narrator else (assigned_char.get("assigned_voice_id") or assigned_char.get("voice_id", narr_vid))
                        last_speaking_char = assigned_char
                    else:
                        quote_spk = b.get("speaker") if not is_narr else narr_name
                        quote_cid = b.get("character_id") if not is_narr else narr_id
                        quote_vid = narr_vid if is_single_narrator else (b.get("voice_id") or narr_vid)

                    attr_clause = ""
                    if idx > 0 and not segments[idx - 1][0]:
                        attr_clause = segments[idx - 1][1]
                    elif idx + 1 < len(segments) and not segments[idx + 1][0]:
                        attr_clause = segments[idx + 1][1]
                    eff_emotion = char_emotion or (cls.extract_acting_tag_from_context(attr_clause, seg_text) if (attr_clause or seg_text) else None)

                    clean_blocks.append({
                        "id": f"{b.get('id', 'b')}_q_{len(clean_blocks)}",
                        "speaker": quote_spk,
                        "character_id": quote_cid,
                        "voice_id": quote_vid,
                        "text": seg_text,
                        "emotion_tag": eff_emotion,
                        "pause_after": 0.4,
                        "engine": engine
                    })
                else:
                    # Narrative tag / action beat
                    # If this segment is solely an emotion/acting tag like [whisper] or [angry, yell], transfer tag
                    etag_match = re.match(r'^\[([a-zA-Z_,\s\-]+)\]$', seg_text)
                    if etag_match:
                        char_emotion = f"[{etag_match.group(1).strip()}]"
                        continue

                    # Strip any inline tags from narration text
                    clean_narr = re.sub(r'\[/?[a-zA-Z_,\s\-]+\]', '', seg_text).strip()
                    if clean_narr:
                        clean_blocks.append({
                            "id": f"{b.get('id', 'b')}_n_{len(clean_blocks)}",
                            "speaker": narr_name,
                            "character_id": narr_id,
                            "voice_id": narr_vid,
                            "text": clean_narr,
                            "emotion_tag": None,
                            "pause_after": 0.5,
                            "engine": engine
                        })

        # Cross-block attribution resolution pass:
        # If block i is a dialogue quote assigned to Narrator, resolve to trailing or leading attribution tags
        for i in range(len(clean_blocks)):
            cb = clean_blocks[i]
            cb_spk = cb.get("speaker", "").lower()
            is_cb_narr = (cb_spk == "narrator") or ("narrator" in cb_spk)
            cb_text = cb.get("text", "").strip()

            if is_cb_narr and cb_text and cb_text[0] in ('"', '“', '«', '‘', "'"):
                matched_char = None
                attr_txt = ""
                # 1. Check trailing attribution (e.g. '‘...’ said Fred.')
                if i + 1 < len(clean_blocks):
                    next_b = clean_blocks[i + 1]
                    next_txt = next_b.get("text", "").strip()
                    matched_char = cls.find_matching_character(next_txt, char_map)
                    if matched_char:
                        attr_txt = next_txt
                # 2. Check leading attribution (e.g. 'Fred shouted: ‘...’')
                if not matched_char and i > 0:
                    prev_b = clean_blocks[i - 1]
                    prev_txt = prev_b.get("text", "").strip()
                    matched_char = cls.find_matching_character(prev_txt, char_map)
                    if matched_char:
                        attr_txt = prev_txt

                if matched_char:
                    cb["speaker"] = matched_char["name"]
                    cb["character_id"] = matched_char["id"]
                    if not is_single_narrator:
                        cb["voice_id"] = matched_char.get("assigned_voice_id", cb.get("voice_id"))

                    # If quote has no emotion tag, derive one from the attribution context
                    if not cb.get("emotion_tag"):
                        cb["emotion_tag"] = cls.extract_acting_tag_from_context(attr_txt, cb_text)

                    # If block i+2 is an immediate continuation quote in the same speech without its own attribution tag:
                    if i + 2 < len(clean_blocks):
                        cont_b = clean_blocks[i + 2]
                        cont_spk = cont_b.get("speaker", "").lower()
                        cont_txt = cont_b.get("text", "").strip()
                        if ("narrator" in cont_spk) and cont_txt and cont_txt[0] in ('"', '“', '«', '‘', "'"):
                            has_own_tag = False
                            if i + 3 < len(clean_blocks):
                                own_attr = cls.find_matching_character(clean_blocks[i + 3].get("text", ""), char_map)
                                if own_attr:
                                    has_own_tag = True
                            if not has_own_tag:
                                cont_b["speaker"] = matched_char["name"]
                                cont_b["character_id"] = matched_char["id"]
                                if not is_single_narrator:
                                    cont_b["voice_id"] = matched_char.get("assigned_voice_id", cont_b.get("voice_id"))
                                if not cont_b.get("emotion_tag"):
                                    cont_b["emotion_tag"] = cls.extract_acting_tag_from_context(attr_txt, cont_txt)

        # Narrative flow optimization: merge adjacent narrator blocks into cohesive storytelling paragraphs
        merged = []
        for b in clean_blocks:
            if not merged:
                merged.append(b)
                continue
            prev = merged[-1]
            is_prev_narr = (prev.get("speaker", "").lower() == "narrator") or ("narrator" in prev.get("speaker", "").lower())
            is_curr_narr = (b.get("speaker", "").lower() == "narrator") or ("narrator" in b.get("speaker", "").lower())

            if is_prev_narr and is_curr_narr:
                prev_txt = prev.get("text", "").strip()
                curr_txt = b.get("text", "").strip()
                # Do not merge chapter headings
                is_heading = prev.get("type") == "heading" or b.get("type") == "heading" or (prev_txt.startswith("—") and prev_txt.endswith("—")) or prev_txt.startswith("#") or curr_txt.startswith("#")
                # Do not merge if either block contains a spoken dialogue quote
                has_quote = (prev_txt and prev_txt[0] in ('"', '“', '‘', "'")) or (curr_txt and curr_txt[0] in ('"', '“', '‘', "'"))

                if not is_heading and not has_quote:
                    # 1. Merge incomplete clauses (ends with comma, semicolon, colon, or dangling word)
                    if prev_txt and (prev_txt[-1] in (',', ';', ':') or re.search(r'[A-Za-z0-9]$', prev_txt)):
                        prev["text"] = prev_txt + " " + curr_txt
                        continue
                    # 2. Combine consecutive scene narration sentences into cohesive storytelling paragraphs (up to 380 chars)
                    prev_tag = prev.get("emotion_tag")
                    curr_tag = b.get("emotion_tag")
                    if (not curr_tag or curr_tag == prev_tag) and (len(prev_txt) + len(curr_txt) + 1 <= 380):
                        prev["text"] = prev_txt + " " + curr_txt
                        continue
            merged.append(b)

        # Renumber block IDs sequentially
        for idx, b in enumerate(merged, 1):
            b["id"] = f"b_{idx}"

        return merged

    @staticmethod
    def _call_gemini_api(api_key: str, model: str, prompt: str, system_prompt: str = "", temperature: float = 0.5, response_json: bool = True) -> str:
        """Calls Google Gemini API via lightweight standard REST with automatic active model fallback."""
        if not api_key:
            raise ValueError("Google Gemini API Key is missing. Please enter your Gemini API Key.")
        if api_key.startswith("sk-fish-"):
            raise ValueError(
                "Invalid Gemini API Key: You entered a Fish Audio key (starts with 'sk-fish-'). "
                "Google Gemini requires an API key starting with 'AIzaSy...' from https://aistudio.google.com/apikey. "
                "To use Fish Audio for TTS voice generation, save this key in Fish Audio Engine settings."
            )

        requested_model = model or "gemini-2.5-flash"
        # Candidate model hierarchy in order of preference (prioritizing fast verified models)
        candidate_models = [requested_model]
        for fallback in ["gemini-2.5-flash", "gemini-3.5-flash-lite"]:
            if fallback not in candidate_models:
                candidate_models.append(fallback)

        last_err = None
        for current_model in candidate_models:
            max_retries = 1
            for attempt in range(max_retries + 1):
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{current_model}:generateContent?key={api_key}"
                gen_cfg: Dict[str, Any] = {
                    "temperature": max(0.1, min(1.0, float(temperature))),
                    "maxOutputTokens": 8192
                }
                if response_json:
                    gen_cfg["responseMimeType"] = "application/json"
                payload: Dict[str, Any] = {
                    "contents": [
                        {
                            "role": "user",
                            "parts": [{"text": prompt}]
                        }
                    ],
                    "generationConfig": gen_cfg
                }
                if system_prompt:
                    payload["systemInstruction"] = {
                        "parts": [{"text": system_prompt}]
                    }

                req = urllib.request.Request(
                    url,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST"
                )
                try:
                    with urllib.request.urlopen(req, timeout=18) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                        candidates = data.get("candidates", [])
                        if candidates and "content" in candidates[0]:
                            parts = candidates[0]["content"].get("parts", [])
                            if parts:
                                return parts[0].get("text", "")
                        raise ValueError("Empty response from Gemini API.")
                except urllib.error.HTTPError as he:
                    err_body = he.read().decode("utf-8", errors="ignore")
                    try:
                        err_json = json.loads(err_body)
                        msg = err_json.get("error", {}).get("message", err_body)
                    except Exception:
                        msg = err_body
                    last_err = RuntimeError(f"Gemini API Error (HTTP {he.code}): {msg}")
                    # If 429 rate limit hit, backoff and retry this model before giving up
                    if he.code == 429 and attempt < max_retries:
                        backoff = 2.5 * (attempt + 1)
                        print(f"[AIDirector] Gemini HTTP 429 rate limit on {current_model}. Backing off {backoff}s (retry {attempt + 1}/{max_retries})...")
                        time.sleep(backoff)
                        continue
                    # If model is 404 (not found) or 503/429/500 (overloaded/spikes), try next fallback model
                    if he.code in (404, 429, 500, 502, 503, 504):
                        print(f"[AIDirector] Gemini model {current_model} returned HTTP {he.code}, attempting fallback model...")
                        break
                    else:
                        raise last_err
                except Exception as e:
                    last_err = e
                    break

        if last_err:
            raise last_err
        raise RuntimeError("No available Gemini model responded successfully.")

    @staticmethod
    def _load_persisted_config() -> Dict[str, Any]:
        """Loads configuration options from projects/config.json if available."""
        cfg_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "projects", "config.json")
        if os.path.exists(cfg_path):
            try:
                with open(cfg_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return {}

    def _call_groq_api(self, api_key: str, model: str, prompt: str, system_prompt: str = "", temperature: float = 0.5, response_json: bool = True) -> str:
        """Calls Groq Cloud API with OpenAI-compatible endpoint and auto-fallback models."""
        target_model = model or "openai/gpt-oss-120b"
        candidates = [target_model]
        for fallback in ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]:
            if fallback not in candidates:
                candidates.append(fallback)

        last_err = None
        for current_model in candidates:
            try:
                return self._call_openai_compatible_api(
                    "https://api.groq.com/openai/v1/chat/completions",
                    api_key,
                    current_model,
                    prompt,
                    system_prompt,
                    temperature,
                    response_json=response_json
                )
            except Exception as e:
                last_err = e
                print(f"[AIDirector] Groq model {current_model} returned {e}, attempting fallback model...")
                continue
        if last_err:
            raise last_err
        raise RuntimeError("No Groq model responded successfully.")

    def _call_openai_api(self, api_key: str, model: str, prompt: str, system_prompt: str = "", temperature: float = 0.5, response_json: bool = True) -> str:
        """Calls OpenAI Chat Completions API."""
        target_model = model or self.DEFAULT_MODELS.get("openai", "gpt-4o-mini")
        return self._call_openai_compatible_api(
            "https://api.openai.com/v1/chat/completions",
            api_key,
            target_model,
            prompt,
            system_prompt,
            temperature,
            response_json=response_json
        )

    def _call_ollama_api(self, model: str, prompt: str, system_prompt: str = "", temperature: float = 0.5, response_json: bool = True) -> str:
        """Calls local Ollama API."""
        host = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
        target_model = model or self.DEFAULT_MODELS.get("ollama", "llama3.2")
        return self._call_openai_compatible_api(
            f"{host}/v1/chat/completions",
            "ollama",
            target_model,
            prompt,
            system_prompt,
            temperature,
            response_json=response_json
        )

    def test_api_key(self, provider: str, api_key: str, model: str = "") -> Dict[str, Any]:
        """Verifies API key with the provider using a minimal ping."""
        target_model = model or self.DEFAULT_MODELS.get(provider, "")
        try:
            if provider == "gemini":
                # Quick ping to Gemini with auto-fallback
                self._call_gemini_api(
                    api_key=api_key,
                    model=target_model,
                    prompt='Reply with JSON: {"status": "ok"}',
                    system_prompt="Return valid JSON."
                )
                used_model = target_model or "gemini-3.5-flash-lite"
                return {"ok": True, "message": f"Google Gemini API key verified and connected ({used_model})", "model": used_model}
            elif provider == "groq":
                self._call_groq_api(
                    api_key=api_key,
                    model=target_model,
                    prompt='Reply with JSON: {"status": "ok"}',
                    system_prompt="Return valid JSON."
                )
                used_model = target_model or "openai/gpt-oss-120b"
                return {"ok": True, "message": f"Groq API key verified and connected ({used_model})", "model": used_model}
            elif provider == "openai":
                self._call_openai_api(
                    api_key=api_key,
                    model=target_model,
                    prompt='Reply with JSON: {"status": "ok"}',
                    system_prompt="Return valid JSON."
                )
                used_model = target_model or self.DEFAULT_MODELS.get("openai", "gpt-4o-mini")
                return {"ok": True, "message": f"OpenAI API key verified and connected ({used_model})", "model": used_model}
            elif provider == "ollama":
                self._call_ollama_api(
                    model=target_model,
                    prompt='Reply with JSON: {"status": "ok"}',
                    system_prompt="Return valid JSON."
                )
                used_model = target_model or self.DEFAULT_MODELS.get("ollama", "llama3.2")
                return {"ok": True, "message": f"Local Ollama verified ({used_model})", "model": used_model}
            else:
                return {"ok": False, "error": f"Unknown provider: {provider}"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    @staticmethod
    def _call_openai_compatible_api(api_url: str, api_key: str, model: str, prompt: str, system_prompt: str = "", temperature: float = 0.5, response_json: bool = True) -> str:
        """Calls OpenAI, Groq, or Local Ollama compatible chat completion API with automatic HTTP 429 backoff retry."""
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "groq-client/1.0" if "groq.com" in api_url else "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        # 4096 tokens ensures full JSON completion without truncation
        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": max(0.1, min(1.0, float(temperature))),
            "max_tokens": 4096
        }
        if response_json:
            payload["response_format"] = {"type": "json_object"}

        max_retries = 2
        for attempt in range(max_retries + 1):
            req = urllib.request.Request(
                api_url,
                data=json.dumps(payload).encode("utf-8"),
                headers=headers,
                method="POST"
            )
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    choices = data.get("choices", [])
                    if choices:
                        return choices[0].get("message", {}).get("content", "")
                    raise ValueError("Empty choices array from LLM completion.")
            except urllib.error.HTTPError as he:
                err_body = he.read().decode("utf-8", errors="ignore")
                try:
                    err_json = json.loads(err_body)
                    msg = err_json.get("error", {}).get("message", err_body)
                except Exception:
                    msg = err_body

                if he.code == 429 and attempt < max_retries:
                    m = re.search(r'try again in ([\d\.]+)s', msg, re.IGNORECASE)
                    wait_sec = float(m.group(1)) + 1.0 if m else 6.0
                    wait_sec = min(max(2.0, wait_sec), 25.0)
                    print(f"[AIDirector] HTTP 429 rate limit on {model}. Waiting {wait_sec:.1f}s before retry {attempt + 1}/{max_retries}...")
                    time.sleep(wait_sec)
                    continue

                raise RuntimeError(f"LLM API Error (HTTP {he.code}): {msg}")
            except Exception as e:
                if attempt < max_retries and "timeout" in str(e).lower():
                    time.sleep(2.0)
                    continue
                raise e

    def call_llm(self, provider: str, api_key: str, model: str, prompt: str, system_prompt: str = "", temperature: float = 0.5, response_json: bool = True) -> str:
        """Routes prompt to the selected LLM provider with custom analysis temperature."""
        prov = (provider or "gemini").lower().strip()
        mod = model or self.DEFAULT_MODELS.get(prov, "gemini-2.5-flash")

        if prov == "gemini":
            if not api_key:
                raise ValueError("Google Gemini API Key is missing. Please enter your Gemini API Key in Agent Settings.")
            return self._call_gemini_api(api_key, mod, prompt, system_prompt, temperature=temperature, response_json=response_json)

        elif prov == "groq":
            if not api_key:
                raise ValueError("Groq API Key is missing. Please enter your Groq API Key.")
            try:
                return self._call_groq_api(api_key, mod or "openai/gpt-oss-120b", prompt, system_prompt, temperature=temperature, response_json=response_json)
            except Exception as e:
                cfg = self._load_persisted_config()
                gem_k = cfg.get("gemini_api_key")
                if gem_k:
                    print(f"[AIDirector] Groq returned error ({e}), seamlessly falling back to Gemini...")
                    return self._call_gemini_api(gem_k, "gemini-2.5-flash", prompt, system_prompt, temperature=temperature, response_json=response_json)
                raise e

        elif prov == "openai":
            if not api_key:
                raise ValueError("OpenAI API Key is missing. Please enter your OpenAI API Key.")
            return self._call_openai_compatible_api("https://api.openai.com/v1/chat/completions", api_key, mod or "gpt-4o-mini", prompt, system_prompt, temperature=temperature, response_json=response_json)

        elif prov in ("ollama", "local"):
            host = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
            return self._call_openai_compatible_api(f"{host}/v1/chat/completions", "ollama", mod or "llama3.2", prompt, system_prompt, temperature=temperature, response_json=response_json)

        else:
            raise ValueError(f"Unsupported LLM provider: {provider}. Choose gemini, groq, openai, or ollama.")

    def direct_story(
        self,
        blocks: List[Dict[str, Any]],
        voices: List[Dict[str, Any]],
        provider: str = "gemini",
        api_key: str = "",
        model: str = "",
        split_dialogue: bool = True,
        cast_voices: bool = True,
        add_emotions: bool = True,
        default_narrator_voice: str = "",
        progress_callback: Optional[Any] = None,
        acting_intensity: str = "balanced",
        analysis_temperature: float = 0.6,
        split_long_emotional_blocks: bool = True,
        tag_placement: str = "pill",
        production_mode: str = "multi",
        existing_characters: Optional[List[Dict]] = None
    ) -> Dict[str, Any]:
        """
        Takes raw story blocks and casts characters with voices, splits dialogue from narration,
        and assigns Fish Speech emotion tags.
        Supports both Multi-Cast Drama (multi-voice) and Single Narrator (solo voice with dialogue beats & tags).
        """
        if not blocks:
            return {"ok": False, "error": "No blocks provided to direct."}

        is_single_narrator = (str(production_mode).lower() == "single") or (not cast_voices)
        chunk_size = 12
        total_chunks = max(1, (len(blocks) + chunk_size - 1) // chunk_size)

        # Smart provider & model reconciliation
        prov = (provider or "").lower().strip()
        mod = model or ""
        if not prov and mod:
            if "gemini" in mod.lower():
                prov = "gemini"
            elif any(x in mod.lower() for x in ["llama", "mixtral", "gemma", "whisper", "gpt-oss"]):
                prov = "groq"
            elif "gpt-" in mod.lower():
                prov = "openai"
            elif "ollama" in mod.lower():
                prov = "ollama"
        if not prov:
            prov = "gemini"
        if not mod:
            mod = self.DEFAULT_MODELS.get(prov, "gemini-3.5-flash-lite")
        if not api_key:
            cfg = self._load_persisted_config()
            api_key = cfg.get(f"{prov}_api_key") or os.environ.get(f"{prov.upper()}_API_KEY", "")
        provider = prov
        model = mod

        if progress_callback:
            try:
                progress_callback({
                    "step": "casting",
                    "percent": 12,
                    "message": "AI Director: Analyzing story & dialogue beats..." if is_single_narrator else "AI Director: Discovering characters & casting library voices...",
                    "total_blocks": len(blocks),
                    "total_chunks": total_chunks,
                    "current_chunk": 0
                })
            except Exception:
                pass

        voice_library_str = self.format_voice_library_prompt(voices)
        narrator_voice_id = default_narrator_voice or (voices[0]["id"] if voices else "voice_stanley_narrator")

        # Phase 1: Character Discovery & Role Casting
        # Broadly sample the manuscript: capture intro exposition + dialogue across the entire chapter
        quote_chars = ['"', '“', '”', '‘', '’', "'"]
        dialogue_verbs = ["said", "asked", "whispered", "cried", "screamed", "murmured", "replied", "shouted", "muttered", "breathed", "snarled", "hissed", "gasped"]
        dialogue_indices = [
            i for i, b in enumerate(blocks)
            if any(q in b.get("text", "") for q in quote_chars) or any(v in b.get("text", "").lower() for v in dialogue_verbs)
        ]
        if len(dialogue_indices) > 55:
            step = len(dialogue_indices) / 55
            sampled_dialogue_idx = [dialogue_indices[int(i * step)] for i in range(55)]
        else:
            sampled_dialogue_idx = dialogue_indices

        combined_idx = sorted(list(set(list(range(min(25, len(blocks)))) + sampled_dialogue_idx)))[:80]
        sample_blocks = [blocks[i] for i in combined_idx]
        text_sample = "\n".join([f"[{i+1}] {b.get('text', '')}" for i, b in enumerate(sample_blocks)])

        if is_single_narrator:
            phase1_system = (
                "You are a master Solo Audiobook Director.\n"
                "A single solo narrator voices the entire story, performing both narrative descriptions and character dialogue in different expressive tones.\n"
                "Your job is to read the story text, discover all characters who speak or act, and identify their personality, age, and emotional persona.\n"
                "Rules:\n"
                "1. Identify the primary Narrator and all speaking characters (e.g. Dudley, Harry, Uncle Vernon).\n"
                f"2. All characters are performed by the solo narrator, so assign voice_id: '{narrator_voice_id}' to all characters.\n"
                "3. Output JSON with a 'characters' array containing {name, gender, persona, assigned_voice_id: '" + narrator_voice_id + "', rationale}."
            )
        else:
            phase1_system = (
                "You are a master Audiobook & Audio Drama Casting Director.\n"
                "Your job is to read the story text, discover all characters who speak or act, and cast each character with the best matching voice from the provided Studio Voice Library.\n"
                "Rules:\n"
                "1. Identify the primary Narrator and all speaking characters (e.g. Uncle Vernon, Aunt Petunia, Dudley, Harry).\n"
                "2. Map each character to exactly one voice_id from the Available Voices list based on character gender, age, personality, and tone.\n"
                "3. Keep the Narrator assigned to the primary storytelling voice.\n"
                "4. Output JSON with a 'characters' array containing {name, gender, persona, assigned_voice_id, rationale}."
            )

        existing_cast_prompt = ""
        if existing_characters:
            lines = [f"- {c['name']}: Voice ID '{c.get('assigned_voice_id')}' ({c.get('persona', 'N/A')})" for c in existing_characters if c.get('name')]
            if lines:
                existing_cast_prompt = (
                    "ESTABLISHED BOOK MASTER CAST (You MUST reuse these exact character names and voice IDs if they appear in this chapter):\n"
                    + "\n".join(lines)
                    + "\n\n"
                )

        phase1_prompt = (
            f"{existing_cast_prompt}"
            f"AVAILABLE VOICES IN STUDIO:\n{voice_library_str}\n\n"
            f"PRIMARY NARRATOR VOICE ID: {narrator_voice_id}\n\n"
            f"CHAPTER MANUSCRIPT SAMPLE:\n{text_sample}\n\n"
            "Return JSON in this format:\n"
            "{\n"
            '  "characters": [\n'
            '    {"name": "Narrator", "gender": "neutral", "assigned_voice_id": "' + narrator_voice_id + '", "persona": "Storyteller"},\n'
            '    {"name": "Character Name", "gender": "male/female", "assigned_voice_id": "' + (narrator_voice_id if is_single_narrator else "voice_id") + '", "persona": "brief description"}\n'
            "  ]\n"
            "}"
        )

        print(f"[AIDirector] Running Phase 1 ({'Solo Narrator Character Analysis' if is_single_narrator else 'Multi-Cast Character Casting'}) via {provider}...")
        try:
            p1_raw = self.call_llm(provider, api_key, model, phase1_prompt, phase1_system)
            p1_json = self.parse_llm_json(p1_raw)
            discovered_characters = p1_json.get("characters", [])
        except (ValueError, RuntimeError) as api_err:
            err_msg = str(api_err)
            if "API" in err_msg or "Key" in err_msg or "quota" in err_msg.lower():
                print(f"[AIDirector] Critical LLM API failure in Phase 1: {api_err}")
                return {
                    "ok": False,
                    "error": f"AI Director failed to contact {provider.capitalize()} API: {api_err}"
                }
            print(f"[AIDirector] Phase 1 non-fatal JSON parse notice: {api_err}")
            discovered_characters = [
                {"name": "Narrator", "assigned_voice_id": narrator_voice_id, "persona": "Primary Storyteller"}
            ]
        except Exception as e:
            print(f"[AIDirector] Phase 1 non-fatal JSON parse notice: {e}")
            discovered_characters = [
                {"name": "Narrator", "assigned_voice_id": narrator_voice_id, "persona": "Primary Storyteller"}
            ]

        palette = [
            "#f59e0b",  # Amber/Gold
            "#10b981",  # Emerald
            "#ec4899",  # Rose/Pink
            "#8b5cf6",  # Purple
            "#06b6d4",  # Cyan
            "#ef4444",  # Red
            "#3b82f6",  # Blue
            "#14b8a6",  # Teal
            "#f97316",  # Orange
        ]
        has_narrator = False
        p_idx = 0
        for i, c in enumerate(discovered_characters):
            c_name = (c.get("name") or "Character").strip()
            is_narr = c_name.lower() == "narrator" or "narrator" in c_name.lower()
            if is_narr:
                has_narrator = True
            c["id"] = c.get("id") or f"char_{int(time.time())}_{i}_{hashlib.md5(c_name.encode()).hexdigest()[:4]}"
            words = c_name.split()
            c["badge"] = c.get("badge") or ((words[0][0] + words[1][0]).upper() if len(words) >= 2 else c_name[:2].upper())
            c["color"] = c.get("color") or ("#6366f1" if is_narr else palette[p_idx % len(palette)])
            if not is_narr:
                p_idx += 1
            if is_single_narrator:
                c["assigned_voice_id"] = narrator_voice_id
            else:
                if not c.get("assigned_voice_id"):
                    c["assigned_voice_id"] = narrator_voice_id if is_narr else (voices[0]["id"] if voices else "voice_stanley_narrator")
            c["voice_id"] = c["assigned_voice_id"]

        if not has_narrator:
            narr_char = {
                "id": f"char_{int(time.time())}_narrator",
                "name": "Narrator",
                "assigned_voice_id": narrator_voice_id,
                "voice_id": narrator_voice_id,
                "badge": "NA",
                "color": "#6366f1",
                "persona": "Primary Storyteller",
                "gender": "neutral"
            }
            discovered_characters.insert(0, narr_char)

        if existing_characters:
            existing_by_name = {c["name"].strip().lower(): c for c in existing_characters if c.get("name")}
            for c in discovered_characters:
                k = (c.get("name") or "").strip().lower()
                if k in existing_by_name:
                    mc = existing_by_name[k]
                    c["id"] = mc.get("id", c.get("id"))
                    if not is_single_narrator:
                        c["assigned_voice_id"] = mc.get("assigned_voice_id", c.get("assigned_voice_id"))
                        c["voice_id"] = c["assigned_voice_id"]
                    if mc.get("persona"):
                        c["persona"] = mc["persona"]
                    if mc.get("badge"):
                        c["badge"] = mc["badge"]
                    if mc.get("color"):
                        c["color"] = mc["color"]
                    if mc.get("reference_audio"):
                        c["reference_audio"] = mc["reference_audio"]
                    if mc.get("reference_text"):
                        c["reference_text"] = mc["reference_text"]
                    if mc.get("default_emotion_tag"):
                        c["default_emotion_tag"] = mc["default_emotion_tag"]

            disc_names = {(c.get("name") or "").strip().lower() for c in discovered_characters}
            for mc in existing_characters:
                k = (mc.get("name") or "").strip().lower()
                if k and k not in disc_names:
                    discovered_characters.append(dict(mc))
                    disc_names.add(k)

        char_map = {c["name"].lower(): c for c in discovered_characters}

        if progress_callback:
            try:
                progress_callback({
                    "step": "cast_ready",
                    "percent": 28,
                    "message": f"Solo narrator prepared ({len(discovered_characters)} characters). Splitting dialogue & tags..." if is_single_narrator else f"Cast established ({len(discovered_characters)} characters). Splitting dialogue & attributing speakers...",
                    "characters": discovered_characters,
                    "total_blocks": len(blocks),
                    "total_chunks": total_chunks,
                    "current_chunk": 0
                })
            except Exception:
                pass

        # Phase 2: Directed Block Generation in safe chunks
        directed_blocks: List[Dict[str, Any]] = []
        block_counter = 1

        intensity_guidance = {
            "subtle": (
                "ACTING TAG INTENSITY: SUBTLE / HIGH DRAMA.\n"
                "- Only tag clear emotional peaks, shouts, screams, distinct whispers, or crying.\n"
                "- Leave calm dialogue neutral (emotion_tag: null) to let the voice actor sound natural."
            ),
            "balanced": (
                "ACTING TAG INTENSITY: BALANCED / EXPRESSIVE (RECOMMENDED).\n"
                "- Analyze dialogues, attitudes, and character reactions carefully.\n"
                "- Add expressive tags for mood, vocal delivery, and reactions on dialogue and emotive lines."
            ),
            "cinematic": (
                "ACTING TAG INTENSITY: DEEP CINEMATIC / HIGH-ACTING.\n"
                "- Deeply analyze subtext, emotional tension, relationships, power dynamics, and hidden character feelings.\n"
                "- MANDATORY VOCAL DIRECTION: Spoken character dialogue is NEVER neutral in cinematic mode. You MUST provide rich, evocative vocal acting tags for EVERY character dialogue line (e.g. [cold][sneer], [suspicious], [whisper][pleading], [impatient], [hiss], [softly], [disdainful], [quiet authority]). Never return emotion_tag: null for character speech."
            )
        }.get(str(acting_intensity).lower(), "ACTING TAG INTENSITY: BALANCED / EXPRESSIVE (RECOMMENDED).")

        split_big_blocks_rule = (
            "5. BIG BLOCKS & EMOTION SHIFTS:\n"
            "   If a character's dialogue is long or changes emotion/tone mid-speech (for example, starts hesitant with a sigh, then gets angry and yells; or a multi-sentence speech where feelings evolve), "
            "SPLIT the speech into separate sequential blocks at the emotional transition so each distinct beat receives its own accurate tag!\n"
        ) if split_long_emotional_blocks else ""

        single_narr_instruction = (
            "SOLO NARRATOR AUDIOBOOK RULES:\n"
            f"- A single solo voice actor reads the entire chapter/story ('{narrator_voice_id}').\n"
            "- CRITICAL RULE: Spoken dialogue inside quotation marks (\"...\", “...”) OR British single quotes ('...', ‘...’) MUST be placed in its own separate speech block from narrative descriptions (e.g. 'said Snape,', 'he whispered.').\n"
            "- The solo narrator reads narrative descriptions in a neutral, immersive storytelling tone, BUT delivers character dialogue in the distinct emotional tone, pitch, and attitude of that character!\n"
            "- Assign rich Fish Speech acting tags (e.g. [cold][sneer], [whisper], [cheerful], [pompous], [sigh], [mocking tone], [impatient]) to the spoken dialogue blocks to direct how the solo narrator should voice that line.\n"
            f"- Every block's voice_id MUST be '{narrator_voice_id}'.\n"
        ) if is_single_narrator else ""

        phase2_system = (
            "You are a master Audiobook & Audio Drama Dialogue Director.\n"
            f"{single_narr_instruction}"
            "You receive numbered story blocks. Your job is to:\n"
            "1. STRICT DIALOGUE & BRITISH QUOTE RULE: Spoken dialogue inside double quotes (\"...\" or “...”) OR British single quotes ('...' or ‘...’) MUST be attributed to the speaking character (e.g. Severus Snape, Bellatrix, Harry, Narcissa), NEVER to Narrator!\n"
            "2. BREAKING LEAD-IN ATTRIBUTION: When a block has narrative attribution before a quote (e.g. \"said Snape, ‘although the Dark Lord is pleased...’\" or \"Bellatrix sneered, ‘Wait!’\"), SPLIT IT into two distinct sequential blocks:\n"
            "   - Block 1: 'said Snape,' -> speaker: 'Narrator', emotion_tag: null\n"
            "   - Block 2: '‘although the Dark Lord is pleased that I never deserted my post...’' -> speaker: 'Severus Snape', emotion_tag: '[cold][sneer]'\n"
            "3. BREAKING TRAILING ATTRIBUTION: When a spoken quote is followed by a dialogue tag (e.g. \"‘Yes, Bellatrix, I stayed,’ said Snape, betraying a hint of impatience\"), SPLIT IT into two distinct blocks:\n"
            "   - Block 1: '‘Yes, Bellatrix, I stayed,’' -> speaker: 'Severus Snape', emotion_tag: '[impatient][softly]'\n"
            "   - Block 2: 'said Snape, betraying a hint of impatience for the first time.' -> speaker: 'Narrator', emotion_tag: null\n"
            "4. ALL dialogue tags, narrative descriptions, and action beats OUTSIDE quotes MUST be placed in a separate block with speaker: 'Narrator' and the Narrator's voice_id.\n"
            "5. IN-SENTENCE SCARE QUOTES & IDIOMS (DO NOT CUT!):\n"
            "   Do NOT split or attribute in-sentence quotes, idioms, titles, slang, or scare quotes that are part of the narrator's prose (e.g. 'what he called the \"rat race\"', 'read a book called \"The Great Gatsby\"').\n"
            "   These belong to the Narrator inside the narrative sentence. ONLY split direct spoken dialogue between characters!\n"
            "6. FISH SPEECH S2 PRO ACTING TAGS TAXONOMY:\n"
            "   Use natural bracketed tags [tag] or discrete compound tags [action][mood] covering:\n"
            "   - Emotion / Psychological Mood: [angry], [cheerful], [terrified], [sarcastic], [sinister], [tender], [desperate], [pompous], [sobbing], [confused], [excited], [heartbroken], [defiant], [gloating], [cold][sneer], [suspicious], [impatient], [quiet authority]\n"
            "   - Delivery / How Sentence is Spoken: [whisper], [yell], [shouting], [murmur], [fast, breathless], [drawling], [trembling voice], [stuttering], [mocking tone], [hiss], [screaming], [softly]\n"
            "   - Physical Action / Paralinguistics: [sigh], [gasp], [chuckle], [laughs], [groan], [inhale], [pant], [snicker], [crying], [cough]\n"
            "   - Combining Physical Actions with Mood: ALWAYS format as [action][mood] (e.g. [chuckle][sarcastic], [sigh][tired], [gasp][panicked], [chuckle][mocking tone], [cold][sneer]) so the neural audio codebook triggers the physical acoustic sound!\n"
            "   - MANDATORY IN CINEMATIC MODE: On Deep Cinematic mode, character dialogue is NEVER neutral. Character lines MUST receive vocal acting tags! Only purely flat narrative description may have emotion_tag: null.\n"
            f"{intensity_guidance}\n"
            f"{split_big_blocks_rule}"
            "7. COMBINING SCENE NARRATION: Do NOT chop consecutive narrative description into tiny 1-line fragments. Combine consecutive descriptive narrative sentences of the same scene beat into cohesive storytelling paragraphs (up to 3-4 sentences / 250-400 characters) so the narrator sounds fluid, cohesive, and cinematic. Spoken character dialogue in quotes remains separate.\n"
            "8. PRESERVE EVERY WORD of the original author's text with 100% fidelity. Do not invent, drop, or summarize story content.\n"
            "Output JSON with a 'blocks' array: [{speaker, voice_id, text, emotion_tag}]."
        )

        # Initialize Autonomous AI Director Agent Working Memory
        agent_memory: Dict[str, Any] = {
            "location": "Opening Scene",
            "atmosphere": "Atmospheric storytelling",
            "active_characters": [c["name"] for c in discovered_characters[:4]],
            "dialogue_tail": [],
            "character_states": {}
        }

        for start_idx in range(0, len(blocks), chunk_size):
            chunk_num = (start_idx // chunk_size) + 1
            if chunk_num > 1:
                # Deliberate pacing to prevent API rate limits and allow high-IQ reasoning
                time.sleep(2.5 if provider == "groq" else 0.8)

            char_cast_summary = "\n".join([f'- {c["name"]}: Voice ID "{c.get("assigned_voice_id")}" ({c.get("persona")})' for c in discovered_characters])

            # Build Live Agent Working Memory Context
            memory_prompt = (
                "DIRECTOR AGENT WORKING MEMORY (STORY STATE & CONTINUITY):\n"
                f"- Scene Setting / Location: {agent_memory.get('location', 'Current Scene')}\n"
                f"- Atmospheric Tension / Mood: {agent_memory.get('atmosphere', 'Expressive storytelling')}\n"
                f"- Active Characters Present: {', '.join(agent_memory.get('active_characters', ['Narrator']))}\n"
            )
            if agent_memory.get("dialogue_tail"):
                tail_str = "\n".join([f'  * [{item.get("speaker")}] ({item.get("emotion") or "neutral"}): "{item.get("text")}"' for item in agent_memory["dialogue_tail"][-2:]])
                memory_prompt += f"- Preceding Dialogue Tail (Immediately before this chunk):\n{tail_str}\n"
            if agent_memory.get("character_states"):
                c_states = ", ".join([f"{k}: {v}" for k, v in agent_memory["character_states"].items() if v])
                if c_states:
                    memory_prompt += f"- Character Psychological & Physical Conditions: {c_states}\n"

            if progress_callback:
                try:
                    pct = 28 + int(68 * (chunk_num - 1) / total_chunks)
                    loc_label = agent_memory.get("location", "")
                    loc_suffix = f" [{loc_label}]" if (loc_label and loc_label != "Opening Scene") else ""
                    progress_callback({
                        "step": "directing",
                        "percent": pct,
                        "message": f"Directing dialogue & acting tags (Chunk {chunk_num} of {total_chunks}){loc_suffix}...",
                        "characters": discovered_characters,
                        "total_blocks": len(blocks),
                        "total_chunks": total_chunks,
                        "current_chunk": chunk_num,
                        "scene_location": agent_memory.get("location"),
                        "scene_mood": agent_memory.get("atmosphere")
                    })
                except Exception:
                    pass

            chunk = blocks[start_idx:start_idx + chunk_size]
            chunk_input = []
            for idx, b in enumerate(chunk):
                b_text = b.get("text", "").strip()
                chunk_input.append(f"[{idx+1}] {b_text}")

            phase2_prompt = (
                f"{memory_prompt}\n"
                f"CASTING DIRECTORY:\n{char_cast_summary}\n\n"
                f"NARRATOR VOICE ID: {narrator_voice_id}\n\n"
                f"CRITICAL RULES:\n"
                "- Characters speak words inside double quotes (\"...\" / “...”) OR British single quotes ('...' / ‘...’). Words outside quotes belong to Narrator.\n"
                "- Lead-in attribution: \"said Snape, ‘although the Dark Lord...’\" -> SPLIT into Narrator (\"said Snape,\") and Character (\"‘although the Dark Lord...’\").\n"
                "- Trailing attribution: \"‘Yes, Bellatrix,’ said Snape.\" -> SPLIT into Character (\"‘Yes, Bellatrix,’\") and Narrator (\"said Snape.\").\n"
                "- In Deep Cinematic mode, character dialogue lines MUST have vocal acting tags (e.g. [cold][sneer], [suspicious], [whisper], [impatient]). Do NOT return null for character speech!\n"
                "- Discrete action tags: use [action][mood] like [chuckle][sarcastic] so physical sounds fire.\n"
                "- COMBINE SCENE NARRATION: Do NOT chop consecutive narrative description into tiny 1-line fragments. Combine consecutive narrative sentences of the same beat into cohesive storytelling paragraphs (up to 250-400 chars) so the narrator sounds fluid and cinematic.\n"
                "- AGENT MEMORY: Output updated scene location, atmosphere, and character emotional states in 'memory_update'.\n"
                "- DYNAMIC CASTING: If a new speaking character appears who is not in the cast directory, list them in 'new_characters' with name and persona.\n\n"
                f"STORY BLOCKS TO DIRECT:\n" + "\n\n".join(chunk_input) + "\n\n"
                "Return JSON in this exact structure:\n"
                "{\n"
                '  "memory_update": {\n'
                '    "location": "Current Scene Location",\n'
                '    "atmosphere": "Atmospheric tension / mood",\n'
                '    "active_characters": ["..."],\n'
                '    "character_states": {"Character Name": "Current emotional/physical state"}\n'
                '  },\n'
                '  "new_characters": [\n'
                '    {"name": "...", "gender": "male/female", "persona": "..."}\n'
                '  ],\n'
                '  "blocks": [\n'
                '    {"speaker": "Severus Snape", "voice_id": "...", "text": "‘although the Dark Lord is pleased that I never deserted my post: I had sixteen years of information on Dumbledore to give him when he returned, a rather more useful welcome-back present than endless reminiscences of how unpleasant Azkaban is …’", "emotion_tag": "[cold][sneer]"},\n'
                '    {"speaker": "Bellatrix", "voice_id": "...", "text": "‘But you stayed —’", "emotion_tag": "[suspicious][whisper]"},\n'
                '    {"speaker": "Severus Snape", "voice_id": "...", "text": "‘Yes, Bellatrix, I stayed,’", "emotion_tag": "[impatient][softly]"},\n'
                '    {"speaker": "Narrator", "voice_id": "' + narrator_voice_id + '", "text": "said Snape, betraying a hint of impatience for the first time.", "emotion_tag": null}\n'
                "  ]\n"
                "}"
            )

            print(f"[AIDirector] Directing batch {start_idx+1} to {min(start_idx+chunk_size, len(blocks))} (Scene: {agent_memory.get('location')})...")
            try:
                p2_raw = self.call_llm(provider, api_key, model, phase2_prompt, phase2_system, temperature=analysis_temperature)
                p2_json = self.parse_llm_json(p2_raw)
                new_sub_blocks = p2_json.get("blocks", [])

                if not new_sub_blocks:
                    raise ValueError("Empty blocks in response")

                # 1. Update Agent Working Memory from LLM output
                mem_up = p2_json.get("memory_update") or {}
                if isinstance(mem_up, dict):
                    if mem_up.get("location"):
                        agent_memory["location"] = str(mem_up["location"]).strip()
                    if mem_up.get("atmosphere"):
                        agent_memory["atmosphere"] = str(mem_up["atmosphere"]).strip()
                    if isinstance(mem_up.get("active_characters"), list) and mem_up["active_characters"]:
                        agent_memory["active_characters"] = [str(c).strip() for c in mem_up["active_characters"]]
                    if isinstance(mem_up.get("character_states"), dict):
                        agent_memory["character_states"].update(mem_up["character_states"])

                # 2. Register newly declared characters from new_characters list
                declared_new_chars = p2_json.get("new_characters") or []
                if isinstance(declared_new_chars, list):
                    for nc in declared_new_chars:
                        if isinstance(nc, dict) and nc.get("name"):
                            nc_name = nc["name"].strip()
                            if nc_name.lower() != "narrator" and nc_name.lower() not in char_map:
                                new_c_id = f"char_{int(time.time())}_{len(discovered_characters)}_{hashlib.md5(nc_name.encode()).hexdigest()[:4]}"
                                target_gender = nc.get("gender") or ("female" if any(g in nc_name.lower() for g in ["mrs", "miss", "lady", "sister", "woman", "girl", "mother", "queen"]) else "male")
                                assigned_v = None
                                if voices:
                                    for v in voices:
                                        if v.get("gender") == target_gender and v.get("id") != narrator_voice_id:
                                            assigned_v = v.get("id")
                                            break
                                    if not assigned_v:
                                        assigned_v = voices[len(discovered_characters) % len(voices)]["id"]
                                else:
                                    assigned_v = narrator_voice_id
                                spk_words = nc_name.split()
                                badge = (spk_words[0][0] + spk_words[1][0]).upper() if len(spk_words) >= 2 else nc_name[:2].upper()
                                created_char = {
                                    "id": new_c_id,
                                    "name": nc_name,
                                    "assigned_voice_id": assigned_v,
                                    "voice_id": assigned_v,
                                    "badge": badge,
                                    "color": palette[len(discovered_characters) % len(palette)],
                                    "persona": nc.get("persona") or f"Speaking character ({nc_name})",
                                    "gender": target_gender
                                }
                                discovered_characters.append(created_char)
                                char_map[nc_name.lower()] = created_char

                for sb in new_sub_blocks:
                    txt = (sb.get("text") or "").strip()
                    if not txt:
                        continue
                    # Strip leading LLM numbering markers e.g. [1], [2], 1., 2)
                    txt = re.sub(r'^\s*\[\d+\]\s*', '', txt)
                    txt = re.sub(r'^\s*\d+[\.\)]\s*', '', txt)
                    if not txt:
                        continue

                    spk = (sb.get("speaker") or "Narrator").strip()
                    matched_char = char_map.get(spk.lower())
                    if not matched_char:
                        matched_char = self.find_matching_character(spk, char_map)
                    if not matched_char:
                        # Check if speaker was output as voice_id
                        for c in char_map.values():
                            if c.get("assigned_voice_id") == spk or c.get("voice_id") == spk:
                                matched_char = c
                                break
                    if not matched_char:
                        for k, c in char_map.items():
                            if k in spk.lower() or spk.lower() in k:
                                matched_char = c
                                break

                    # Dynamically create newly discovered character if LLM attributes speaker not yet in cast
                    if not matched_char and spk.lower() != "narrator":
                        new_c_id = f"char_{int(time.time())}_{len(discovered_characters)}_{hashlib.md5(spk.encode()).hexdigest()[:4]}"
                        assigned_v = None
                        spk_l = spk.lower()
                        is_fem = any(g in spk_l for g in ["mrs", "miss", "lady", "sister", "woman", "girl", "mother", "queen", "bellatrix", "narcissa", "petunia", "hermione", "bella", "cissy"])
                        target_gender = "female" if is_fem else "male"
                        if voices:
                            for v in voices:
                                if v.get("gender") == target_gender and v.get("id") != narrator_voice_id:
                                    assigned_v = v.get("id")
                                    break
                            if not assigned_v:
                                assigned_v = voices[len(discovered_characters) % len(voices)]["id"]
                        else:
                            assigned_v = narrator_voice_id

                        spk_words = spk.split()
                        badge = (spk_words[0][0] + spk_words[1][0]).upper() if len(spk_words) >= 2 else spk[:2].upper()
                        new_char = {
                            "id": new_c_id,
                            "name": spk,
                            "assigned_voice_id": assigned_v,
                            "voice_id": assigned_v,
                            "badge": badge,
                            "color": palette[len(discovered_characters) % len(palette)],
                            "persona": f"Speaking character ({spk})",
                            "gender": target_gender
                        }
                        discovered_characters.append(new_char)
                        char_map[spk.lower()] = new_char
                        matched_char = new_char

                    if not matched_char:
                        matched_char = char_map.get("narrator", discovered_characters[0])

                    spk_name = matched_char["name"]
                    cid = matched_char["id"]
                    vid = narrator_voice_id if is_single_narrator else (sb.get("voice_id") or matched_char["assigned_voice_id"])
                    etag = sb.get("emotion_tag")
                    if etag:
                        etag = FishEngine.decompose_emotion_tag(etag)

                    # Clean tag if already prefixed in text
                    if etag and txt.startswith(etag):
                        txt = txt[len(etag):].strip()

                    # Apply user's tag placement preference
                    final_txt = txt
                    final_etag = etag
                    if etag:
                        if tag_placement in ("inline", "both") and not final_txt.startswith("["):
                            final_txt = f"{etag}{final_txt}"
                        if tag_placement == "inline":
                            final_etag = None  # purely inside text

                    directed_blocks.append({
                        "id": f"b_{block_counter}",
                        "speaker": spk_name,
                        "character_id": cid,
                        "voice_id": vid,
                        "text": final_txt,
                        "emotion_tag": final_etag,
                        "pause_after": 0.6 if spk_name.lower() == "narrator" else 0.4
                    })
                    block_counter += 1

                # Update Dialogue Tail for the next chunk's working memory bridge
                chunk_tail = []
                for db in directed_blocks[-3:]:
                    if db.get("text"):
                        chunk_tail.append({
                            "speaker": db.get("speaker", "Narrator"),
                            "text": db.get("text", "")[:120],
                            "emotion": db.get("emotion_tag")
                        })
                agent_memory["dialogue_tail"] = chunk_tail

            except Exception as batch_err:
                print(f"[AIDirector] Batch direct notice ({batch_err}), applying intelligent rule-based dialogue attribution & acting tags.")
                narr_char = char_map.get("narrator", discovered_characters[0])
                fallback_blocks = self.rule_based_direct_blocks(
                    chunk,
                    char_map,
                    narr_char,
                    is_single_narrator=is_single_narrator,
                    acting_intensity=acting_intensity
                )
                for fb in fallback_blocks:
                    fb["id"] = f"b_{block_counter}"
                    directed_blocks.append(fb)
                    block_counter += 1

                # Update Dialogue Tail from fallback blocks
                chunk_tail = []
                for db in directed_blocks[-3:]:
                    if db.get("text"):
                        chunk_tail.append({
                            "speaker": db.get("speaker", "Narrator"),
                            "text": db.get("text", "")[:120],
                            "emotion": db.get("emotion_tag")
                        })
                agent_memory["dialogue_tail"] = chunk_tail

        # Guarantee strict separation of character quotes from narrator attribution tags
        narr_char = char_map.get("narrator", discovered_characters[0])
        if split_dialogue and directed_blocks:
            directed_blocks = self.sanitize_and_split_dialogue(directed_blocks, narr_char, char_map, is_single_narrator=is_single_narrator)

        # Consolidate consecutive short narrative sentences of the same beat into fluid paragraphs
        try:
            from core.project_manager import ProjectManager
            _pm = ProjectManager()
            directed_blocks = _pm.merge_ultra_small_blocks(directed_blocks, max_chars=90, max_words=16, max_merged_chars=320)
        except Exception as _m_err:
            print(f"[AIDirector] Note on post-direct block consolidation: {_m_err}")

        if progress_callback:
            try:
                progress_callback({
                    "step": "done",
                    "percent": 100,
                    "message": f"Directing complete! Solo narrator chapter directed with dialogue beats across {len(directed_blocks)} speech blocks." if is_single_narrator else f"Directing complete! Cast {len(discovered_characters)} characters across {len(directed_blocks)} speech blocks.",
                    "characters": discovered_characters,
                    "total_blocks": len(directed_blocks),
                    "total_chunks": total_chunks,
                    "current_chunk": total_chunks
                })
            except Exception:
                pass

        return {
            "ok": True,
            "provider": provider,
            "characters": discovered_characters,
            "total_blocks": len(directed_blocks),
            "blocks": directed_blocks,
            "summary": f"Directing complete! Cast {len(discovered_characters)} characters across {len(directed_blocks)} speech blocks."
        }

    def agent_chat(
        self,
        messages: List[Dict[str, str]],
        project_context: Dict[str, Any],
        available_voices: List[Dict[str, Any]],
        provider: str = "",
        api_key: str = "",
        model: str = "",
        temperature: float = 0.5
    ) -> Dict[str, Any]:
        """
        Interactive AI Director Agent chat session.
        Interprets natural English instructions, inspects the current story project,
        and returns conversational direction + atomic execution actions.
        """
        cfg = self._load_persisted_config()
        prov = (provider or "").lower().strip()
        mod = model or ""
        if not prov and mod:
            if "gemini" in mod.lower():
                prov = "gemini"
            elif any(x in mod.lower() for x in ["llama", "mixtral", "gemma", "whisper", "gpt-oss"]):
                prov = "groq"
            elif "gpt-" in mod.lower():
                prov = "openai"
            elif "ollama" in mod.lower():
                prov = "ollama"
        if not prov:
            prov = (cfg.get("default_llm_provider") or "gemini").lower().strip()
        if not mod:
            mod = cfg.get(f"{prov}_model") or self.DEFAULT_MODELS.get(prov, "gemini-3.5-flash-lite")
        key = api_key or cfg.get(f"{prov}_api_key") or os.environ.get(f"{prov.upper()}_API_KEY", "")

        title = project_context.get("title", "Untitled Project")
        blocks = project_context.get("blocks", [])
        saved_chars = project_context.get("saved_characters", [])
        selected_indices = project_context.get("selected_indices", [])

        # 1. Format Cast summary
        cast_lines = []
        for c in saved_chars:
            cid = c.get("id", "")
            cname = c.get("name", "Unknown")
            cvid = c.get("voice_id", "")
            cspd = c.get("speed", 1.0)
            cpitch = c.get("pitch_shift", 0.0)
            cfilt = c.get("fx_filter", "none")
            cast_lines.append(f'- Character "{cname}" (ID: {cid}): Voice="{cvid}", Speed={cspd}x, Pitch={cpitch}st, Filter={cfilt}')
        cast_text = "\n".join(cast_lines) if cast_lines else "None registered yet (using Narrator)."

        # 2. Format Voices summary (limit to top 15 for prompt brevity)
        voice_lines = []
        for v in available_voices[:15]:
            vid = v.get("id") or v.get("voice_id", "")
            vname = v.get("name") or v.get("title", vid)
            vgender = v.get("gender", "neutral")
            vdesc = v.get("description") or v.get("timbre") or ", ".join(v.get("tags", [])) or "Expressive voice"
            voice_lines.append(f'- ID: "{vid}" | Name: "{vname}" | Gender: {vgender} | Timbre: {vdesc}')
        voices_text = "\n".join(voice_lines) if voice_lines else "Standard Voice Roster available."

        # 3. Format Blocks summary (compact length if large project to remain well within Groq TPM limits)
        block_lines = []
        max_txt_len = 45 if len(blocks) > 60 else 75
        for idx, b in enumerate(blocks):
            b_spk = b.get("speaker") or "Narrator"
            b_txt = (b.get("text") or "").strip().replace("\n", " ")
            if len(b_txt) > max_txt_len:
                b_txt = b_txt[:max_txt_len - 3] + "..."
            b_emo = b.get("emotion_tag") or ""
            b_spd = b.get("speed", 1.0)
            b_status = "Ready" if (b.get("cachedAudioUrl") or b.get("audio_url")) else "Draft"
            emo_str = f" | emo: {b_emo}" if b_emo else ""
            block_lines.append(f'Sentence #{idx + 1} (index {idx}) [{b_spk}{emo_str} | {b_spd:.2f}x | {b_status}]: "{b_txt}"')

        blocks_text = "\n".join(block_lines) if block_lines else "No sentences in story."

        # 4. Format Active Selection
        sel_text = "None (user is viewing entire chapter)."
        if selected_indices:
            sel_details = []
            for s_idx in selected_indices:
                if 0 <= s_idx < len(blocks):
                    sb = blocks[s_idx]
                    sel_details.append(f'Sentence #{s_idx + 1} (index {s_idx}): Speaker="{sb.get("speaker")}", Voice="{sb.get("voice_id")}", Emo="{sb.get("emotion_tag")}", Speed={sb.get("speed")}, Text="{sb.get("text")}"')
            sel_text = "\n".join(sel_details)

        # 5. Build System Prompt
        system_prompt = f"""You are the AI Director Agent in Fish Speech Studio, an advanced audio drama and audiobook production platform.
You are a brilliant creative director, dialogue editor, and audio engineer.
You have FULL authority to inspect the script, edit sentences, split or merge dialogue quotes, cast voices, assign characters, and tune pacing/audio tone in real time.

CURRENT PROJECT CONTEXT:
- Project Title: "{title}"
- Total Sentences: {len(blocks)}
- Chapter Cast:
{cast_text}

- Available Voice Catalogue:
{voices_text}

- User Currently Selected Sentences:
{sel_text}

- Story Script Sentences (Index, Speaker, Emotion, Speed, Status, Text):
{blocks_text}

YOUR MISSION & RULES:
1. Act like an expert, autonomous AI Director Agent (just like a high-level coding agent refactoring a codebase).
2. Think, plan, and explain your creative decisions naturally in your response: describe what scenes you are pacing, how you are breaking down large narrative blocks into dramatic beats, and what emotions you are injecting. Speaking in conversational or future tense ("I am breaking Sentence #2 into 4 suspenseful beats and pacing the flashlight reveal...") is great and encouraged!
3. CRITICAL EXECUTION: In the SAME turn, you MUST actually perform the work by outputting the exact atomic actions inside <agent_actions> [ ... ] </agent_actions> as valid JSON!
4. DO NOT delegate to macro functions: You are the director—you inspect the sentences and perform the actual creative dialogue splitting, emotional tagging, and pacing adjustments line by line yourself!
5. All block indices in your JSON actions MUST be 0-based index numbers matching "index Y" from the sentence list above. Note: The user in chat usually refers to sentences with 1-based numbers like "#1", "#2" (e.g. user says "break block #2", meaning Sentence #2 which is index 1 in your script). Always map the user's sentence number to the matching block!
6. FISH SPEECH S2 PRO DUAL-TAG SYSTEM (HOW TO USE [][]):
   Fish Speech S2 Pro uses tightly bound discrete brackets without spaces: `[action][mood]`
   - Paralinguistic Action Tags (one-shot physical acoustic sounds):
     [sigh], [gasp], [chuckle], [laughs], [groan], [pant], [sobbing], [cough], [yawn], [throat-clearing]
   - Tone / Delivery / Mood Tags (continuous acoustic acting styles):
     [whispering in terror], [uncanny realization], [eerie deadpan], [trembling voice], [cold menace],
     [panicked breath], [sinister], [softly], [urgent], [tense suspense], [fear], [cheerful]
   - Dual-Tag Syntax: Combine an action and a mood tag as `[action][mood]`, e.g.:
     `[sigh][uncanny realization]`, `[gasp][whispering in terror]`, `[chuckle][sinister]`, `[pant][panicked]`, `[trembling voice][fear]`
   - Single-Tag Syntax: When no physical sound is required, use a single evocative mood tag, e.g. `[eerie deadpan]`, `[uncanny realization]`, `[tense suspense]`.
   - In your actions, assign tags via the "emotion_tag" field (e.g. "emotion_tag": "[sigh][uncanny realization]").
7. If no edits to the project are needed (e.g. user asks a pure question or general advice), do NOT include the <agent_actions> tag.
8. NEVER MENTION TOKEN LIMITS, QUOTAS, TIMEOUTS, OR BATCHING:
   - NEVER complain about, apologize for, or mention token limits, rate limits, timeouts, API constraints, or batching to the user.
   - You are a high-level creative studio director. If the user asks for changes across the entire script, whole story, or all blocks (e.g. 100, 195, or 300+ blocks), process and apply your direction to the entire requested scope from start to finish! NEVER arbitrarily limit your work to just a small slice (such as 'Sentences 0 through 15') or make excuses.
   - If past error notices appear in history, completely ignore them and execute the latest request.
9. MASS TAGGING & COMPACT UPDATES:
   - When tagging or updating many sentences across the story, you can use the ultra-fast compact action:
     {{ "action": "BATCH_TAGS", "tags": {{ "0": "[ominous whisper]", "1": "[tense silence]", "2": "[whispering in terror]" }} }}
     or group consecutive indices in UPDATE_BLOCKS:
     {{ "action": "UPDATE_BLOCKS", "indices": [0, 1, 2], "emotion_tag": "[tense suspense]" }}

SUPPORTED ACTION TYPES:
- BATCH_TAGS / APPLY_TAGS:
  {{ "action": "BATCH_TAGS", "tags": {{ "0": "[ominous whisper]", "1": "[tense silence]", "2": "[whispering in terror]" }} }}
  (Fast, compact assignment of emotion tags or speeds across any number of blocks)
- SPLIT_BLOCK:
  {{ "action": "SPLIT_BLOCK", "index": 1, "split_at": "optional delimiter", "new_segments": [ {{ "text": "First part of sentence...", "speaker": "Narrator", "emotion_tag": "[whispering in terror]", "speed": 1.12 }}, {{ "text": "Second part of sentence...", "speaker": "Narrator", "emotion_tag": "[panicked breath]", "speed": 1.05 }} ] }}
- UPDATE_BLOCKS:
  {{ "action": "UPDATE_BLOCKS", "indices": [0, 1], "speaker": "Lucy", "character_id": "optional_id", "voice_id": "optional_voice_id", "emotion_tag": "[whispering in terror]", "speed": 1.12, "pitch_shift": 0.0, "warmth": 0.0, "clarity": 0.0, "reverb": 0.1, "fx_filter": "none"|"radio"|"whisper"|"scream"|"demon"|"youth", "pause_after": 0.3, "text": "Optional new text if re-wording" }}
- MERGE_BLOCKS:
  {{ "action": "MERGE_BLOCKS", "indices": [4, 5] }}
- MERGE_SHORT / CONSOLIDATE_NARRATION:
  {{ "action": "MERGE_SHORT" }} (Consolidates consecutive short narrative sentences across the chapter into fluid paragraphs)
- DELETE_BLOCKS:
  {{ "action": "DELETE_BLOCKS", "indices": [2] }}
- INSERT_BLOCK:
  {{ "action": "INSERT_BLOCK", "after_index": 2, "text": "New sentence text.", "speaker": "Narrator", "voice_id": "optional_voice_id", "emotion_tag": "" }}
- CREATE_CHARACTER:
  {{ "action": "CREATE_CHARACTER", "name": "The Fog Entity", "voice_id": "voice_death_wolf", "speed": 0.85, "pitch_shift": -2.0, "reverb": 0.20, "color": "#ef4444", "badge": "FE" }}
- EDIT_CHARACTER:
  {{ "action": "EDIT_CHARACTER", "character_id": "char_id_or_name", "name": "Lucy", "voice_id": "voice_female_soft", "speed": 1.05, "pitch_shift": 0.5, "warmth": 1.0, "clarity": 0.5, "reverb": 0.0, "fx_filter": "none" }}
- ASSIGN_CHARACTER:
  {{ "action": "ASSIGN_CHARACTER", "character_id": "char_id_or_name", "indices": [1, 3, 5] }}
- CLEAN_PAUSES:
  {{ "action": "CLEAN_PAUSES" }}
- RENDER_BLOCKS:
  {{ "action": "RENDER_BLOCKS", "indices": [0, 1] }}

Output your natural conversational advice and explanation first in English, followed by `<agent_actions>[ ... ]</agent_actions>` if edits are requested.
CRITICAL FORMATTING RULE:
- NEVER output raw JSON directly into the conversation bubble.
- Always explain what you are doing in friendly, professional English first.
- Put ALL executable actions strictly inside the `<agent_actions>[ ... ]</agent_actions>` container at the very end."""

        # 6. Format recent conversation messages (sanitized to remove past error banners)
        convo_lines = []
        for m in messages[-8:]:
            content = (m.get("content") or "").strip()
            # Filter out error alerts, token error notices, and raw action payloads from history
            if not content or "Director Error" in content or "⚠️" in content or "HTTP 413" in content or "HTTP 429" in content or "token limit" in content.lower():
                continue
            # If past assistant message contained <agent_actions>, strip actions so prompt history is compact and clean
            if "<agent_actions>" in content:
                content = content.split("<agent_actions>")[0].strip()
            role = "User" if m.get("role") in ("user", "human") else "AI Director"
            convo_lines.append(f"{role}: {content}")
        user_prompt = "\n\n".join(convo_lines) if convo_lines else "Hello AI Director, please review the project."

        try:
            raw_response = self.call_llm(
                provider=prov,
                api_key=key,
                model=mod,
                prompt=user_prompt,
                system_prompt=system_prompt,
                temperature=temperature,
                response_json=False
            )
        except Exception as e:
            return {
                "ok": False,
                "error": str(e),
                "provider": prov,
                "model": mod
            }

        # 7. Extract Actions
        actions = []
        clean_reply = raw_response
        action_raw = None

        action_match = re.search(r"<agent_actions>(.*?)</agent_actions>", raw_response, re.DOTALL | re.IGNORECASE)
        if action_match:
            action_raw = action_match.group(1).strip()
            clean_reply = (raw_response[:action_match.start()] + raw_response[action_match.end():]).strip()
        elif "<agent_actions>" in raw_response:
            # Model started <agent_actions> but missed the closing tag
            idx = raw_response.find("<agent_actions>")
            clean_reply = raw_response[:idx].strip()
            action_raw = raw_response[idx + len("<agent_actions>"):].strip()

        if action_raw:
            try:
                parsed = json.loads(action_raw)
                if isinstance(parsed, list):
                    actions = parsed
                elif isinstance(parsed, dict):
                    actions = [parsed]
            except Exception:
                try:
                    actions = self.parse_llm_json(action_raw)
                    if isinstance(actions, dict) and "actions" in actions:
                        actions = actions["actions"]
                    elif isinstance(actions, dict):
                        actions = [actions]
                except Exception as parse_err:
                    print(f"[AIDirector] Could not parse action block: {parse_err}")
        else:
            # Fallback 1: check if entire response is a JSON list of actions or a dict with actions
            try:
                parsed_root = self.parse_llm_json(raw_response)
                if isinstance(parsed_root, list):
                    actions = parsed_root
                    clean_reply = "I have analyzed the script and applied the requested scene breakdowns, emotional delivery tags, and pacing adjustments."
                elif isinstance(parsed_root, dict):
                    if any(k in parsed_root for k in ("message", "reply", "response", "text")):
                        clean_reply = parsed_root.get("response") or parsed_root.get("message") or parsed_root.get("reply") or parsed_root.get("text") or clean_reply
                    if "agent_actions" in parsed_root and isinstance(parsed_root["agent_actions"], list):
                        actions = parsed_root["agent_actions"]
                    elif "actions" in parsed_root and isinstance(parsed_root["actions"], list):
                        actions = parsed_root["actions"]
            except Exception:
                pass

            # Fallback 2: check for ```json [ ... ] ``` blocks
            if not actions and "```" in raw_response:
                for chunk in raw_response.split("```"):
                    c_clean = chunk.strip()
                    if c_clean.startswith("json"):
                        c_clean = c_clean[4:].strip()
                    if c_clean.startswith("[") and c_clean.endswith("]") and '"action"' in c_clean:
                        try:
                            actions = json.loads(c_clean)
                            clean_reply = raw_response.replace(f"```{chunk}```", "").strip()
                            break
                        except Exception:
                            pass

            # Fallback 3: search for any raw JSON array containing "action"
            if not actions:
                array_match = re.search(r"(\[\s*\{.*?\}\s*\])", raw_response, re.DOTALL)
                if array_match and '"action"' in array_match.group(1):
                    try:
                        c_actions = json.loads(array_match.group(1))
                        if isinstance(c_actions, list) and len(c_actions) > 0:
                            actions = c_actions
                            clean_reply = (raw_response[:array_match.start()] + raw_response[array_match.end():]).strip()
                    except Exception:
                        pass

        # Strip any stray action tags or unclosed action tags from clean_reply
        if "<agent_actions>" in clean_reply:
            clean_reply = clean_reply.split("<agent_actions>")[0].strip()
        if "</agent_actions>" in clean_reply:
            clean_reply = clean_reply.replace("</agent_actions>", "").strip()

        # Guarantee clean_reply is friendly conversational English, never raw JSON
        clean_stripped = clean_reply.strip()
        if not clean_stripped or clean_stripped.startswith("[") or clean_stripped.startswith("{") or clean_stripped.startswith("```"):
            clean_reply = "I've reviewed the script and applied the requested character casting, emotional acting tags, and block adjustments."

        return {
            "ok": True,
            "reply": clean_reply,
            "actions": actions,
            "provider": prov,
            "model": mod
        }
