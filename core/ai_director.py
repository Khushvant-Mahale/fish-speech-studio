import os
import re
import json
import time
import hashlib
import urllib.request
import urllib.error
from typing import List, Dict, Any, Optional

class AIDirector:
    """
    Intelligent LLM-powered Story Director & Character Casting Engine.
    Supports Google Gemini (3.5 Flash / 3.8 Flash), Groq, OpenAI, and Local Ollama.
    """

    DEFAULT_MODELS = {
        "gemini": "gemini-3.5-flash-lite",
        "groq": "llama-3.3-70b-versatile",
        "openai": "gpt-4o-mini",
        "ollama": "llama3.2"
    }

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

    @staticmethod
    def extract_quote_segments(text: str) -> List[tuple]:
        """
        Extracts quoted dialogue segments and narrative segments from text.
        Returns a list of tuples: (is_dialogue: bool, segment_text: str)
        Supports curly double quotes “...”, straight double quotes "...",
        guillemets «...», and curly single quotes ‘...’ (protecting internal apostrophes).
        """
        pattern = re.compile(
            r'('
            r'“[^”\r\n]*”'
            r'|"[^"\r\n]*"'
            r'|«[^»\r\n]*»'
            r'|‘(?:[^’\r\n]|(?<=\w)’(?=\w))*’'
            r')'
        )
        segments = []
        last_end = 0
        for m in pattern.finditer(text):
            start, end = m.span()
            if start > last_end:
                narr = text[last_end:start].strip()
                if narr:
                    segments.append((False, narr))
            q = m.group(0).strip()
            if q:
                segments.append((True, q))
            last_end = end
        if last_end < len(text):
            narr = text[last_end:].strip()
            if narr:
                segments.append((False, narr))
        return segments

    @classmethod
    def sanitize_and_split_dialogue(
        cls,
        blocks: List[Dict[str, Any]],
        narrator_char: Dict[str, Any],
        char_map: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """
        Guarantees that characters ONLY speak words enclosed within quotation marks.
        Any narrative lead-ins, dialogue attribution tags (e.g., 'Ray asked,', 'she whispered.'),
        or action beats outside quotation marks are strictly separated into Narrator speech blocks.
        """
        quote_detect = re.compile(r'[\"“«‘]')
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

            if is_narr:
                clean_blocks.append(b)
                continue

            # Speaking character block!
            if not quote_detect.search(text):
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
                    clean_blocks.append(b)
                continue

            # Character block contains quotation marks! Separate dialogue from narration
            segments = cls.extract_quote_segments(text)
            engine = b.get("engine", "fish_s2")
            char_emotion = b.get("emotion_tag")

            for is_quote, seg_text in segments:
                seg_text = seg_text.strip()
                if not seg_text:
                    continue

                if is_quote:
                    # Character dialogue
                    clean_blocks.append({
                        "id": f"{b.get('id', 'b')}_q_{len(clean_blocks)}",
                        "speaker": b.get("speaker"),
                        "character_id": b.get("character_id"),
                        "voice_id": b.get("voice_id"),
                        "text": seg_text,
                        "emotion_tag": char_emotion,
                        "pause_after": b.get("pause_after", 0.4),
                        "engine": engine
                    })
                else:
                    # Narrative tag / action beat
                    # If this segment is solely an emotion tag like [whisper] or [angry], transfer tag
                    etag_match = re.match(r'^\[([a-zA-Z_]+)\]$', seg_text)
                    if etag_match:
                        char_emotion = f"[{etag_match.group(1)}]"
                        continue

                    # Strip any inline tags from narration text
                    clean_narr = re.sub(r'\[/?[a-zA-Z_]+\]', '', seg_text).strip()
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

        # Narrative flow optimization: merge adjacent narrator blocks if prior block is an incomplete clause
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
                if not is_heading:
                    # Merge if prev ends with comma, semicolon, colon, or unpunctuated dangling word
                    if prev_txt and (prev_txt[-1] in (',', ';', ':') or re.search(r'[A-Za-z0-9]$', prev_txt)):
                        prev["text"] = prev_txt + " " + curr_txt
                        continue
            merged.append(b)

        # Renumber block IDs sequentially
        for idx, b in enumerate(merged, 1):
            b["id"] = f"b_{idx}"

        return merged

    @staticmethod
    def _call_gemini_api(api_key: str, model: str, prompt: str, system_prompt: str = "") -> str:
        """Calls Google Gemini API via lightweight standard REST with automatic active model fallback."""
        requested_model = model or "gemini-3.5-flash-lite"
        # Candidate model hierarchy in order of preference (prioritizing high-speed, high-quota models)
        candidate_models = [requested_model]
        for fallback in ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.8-flash"]:
            if fallback not in candidate_models:
                candidate_models.append(fallback)

        last_err = None
        for current_model in candidate_models:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{current_model}:generateContent?key={api_key}"
            payload: Dict[str, Any] = {
                "contents": [
                    {
                        "role": "user",
                        "parts": [{"text": prompt}]
                    }
                ],
                "generationConfig": {
                    "temperature": 0.2,
                    "responseMimeType": "application/json"
                }
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
                with urllib.request.urlopen(req, timeout=45) as resp:
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
                # If model is 404 (not found / deprecated), try next fallback model
                if he.code == 404:
                    continue
                else:
                    raise last_err
            except Exception as e:
                last_err = e
                continue

        if last_err:
            raise last_err
        raise RuntimeError("No available Gemini model responded successfully.")

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
                return {"ok": True, "message": f"Google Gemini API key verified and connected ({target_model})", "model": target_model}
            elif provider == "groq":
                self._call_groq_api(
                    api_key=api_key,
                    model=target_model,
                    prompt='Reply with JSON: {"status": "ok"}',
                    system_prompt="Return valid JSON."
                )
                return {"ok": True, "message": f"Groq API key verified and connected ({target_model})", "model": target_model}
            elif provider == "openai":
                self._call_openai_api(
                    api_key=api_key,
                    model=target_model,
                    prompt='Reply with JSON: {"status": "ok"}',
                    system_prompt="Return valid JSON."
                )
                return {"ok": True, "message": f"OpenAI API key verified and connected ({target_model})", "model": target_model}
            elif provider == "ollama":
                self._call_ollama_api(
                    model=target_model,
                    prompt='Reply with JSON: {"status": "ok"}',
                    system_prompt="Return valid JSON."
                )
                return {"ok": True, "message": f"Local Ollama verified ({target_model})", "model": target_model}
            else:
                return {"ok": False, "error": f"Unknown provider: {provider}"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    @staticmethod
    def _call_openai_compatible_api(api_url: str, api_key: str, model: str, prompt: str, system_prompt: str = "") -> str:
        """Calls OpenAI, Groq, or Local Ollama compatible chat completion API."""
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.2,
            "response_format": {"type": "json_object"}
        }

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
            raise RuntimeError(f"LLM API Error (HTTP {he.code}): {msg}")

    def call_llm(self, provider: str, api_key: str, model: str, prompt: str, system_prompt: str = "") -> str:
        """Routes prompt to the selected LLM provider."""
        prov = (provider or "gemini").lower().strip()
        mod = model or self.DEFAULT_MODELS.get(prov, "gemini-2.0-flash")

        if prov == "gemini":
            if not api_key:
                raise ValueError("Google Gemini API Key is missing. Please enter your Gemini API Key.")
            return self._call_gemini_api(api_key, mod, prompt, system_prompt)

        elif prov == "groq":
            if not api_key:
                raise ValueError("Groq API Key is missing. Please enter your Groq API Key.")
            return self._call_openai_compatible_api("https://api.groq.com/openai/v1/chat/completions", api_key, mod or "llama-3.3-70b-versatile", prompt, system_prompt)

        elif prov == "openai":
            if not api_key:
                raise ValueError("OpenAI API Key is missing. Please enter your OpenAI API Key.")
            return self._call_openai_compatible_api("https://api.openai.com/v1/chat/completions", api_key, mod or "gpt-4o-mini", prompt, system_prompt)

        elif prov in ("ollama", "local"):
            host = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
            return self._call_openai_compatible_api(f"{host}/v1/chat/completions", "ollama", mod or "llama3.2", prompt, system_prompt)

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
        progress_callback: Optional[Any] = None
    ) -> Dict[str, Any]:
        """
        Takes raw story blocks and casts characters with voices, splits dialogue from narration,
        and assigns Fish Speech emotion tags.
        """
        if not blocks:
            return {"ok": False, "error": "No blocks provided to direct."}

        chunk_size = 25
        total_chunks = max(1, (len(blocks) + chunk_size - 1) // chunk_size)

        if progress_callback:
            try:
                progress_callback({
                    "step": "casting",
                    "percent": 12,
                    "message": "AI Director: Discovering characters & casting library voices...",
                    "total_blocks": len(blocks),
                    "total_chunks": total_chunks,
                    "current_chunk": 0
                })
            except Exception:
                pass

        voice_library_str = self.format_voice_library_prompt(voices)
        narrator_voice_id = default_narrator_voice or (voices[0]["id"] if voices else "voice_stanley_narrator")

        # Phase 1: Character Discovery & Role Casting
        # Pass an overview sample of the chapter text to discover characters and assign voices
        sample_blocks = blocks[:40] if len(blocks) > 40 else blocks
        text_sample = "\n".join([f"[{i+1}] {b.get('text', '')}" for i, b in enumerate(sample_blocks)])

        phase1_system = (
            "You are a master Audiobook & Audio Drama Casting Director.\n"
            "Your job is to read the story text, discover all characters who speak or act, and cast each character with the best matching voice from the provided Studio Voice Library.\n"
            "Rules:\n"
            "1. Identify the primary Narrator and all speaking characters (e.g. Uncle Vernon, Aunt Petunia, Dudley, Harry).\n"
            "2. Map each character to exactly one voice_id from the Available Voices list based on character gender, age, personality, and tone.\n"
            "3. Keep the Narrator assigned to the primary storytelling voice.\n"
            "4. Output JSON with a 'characters' array containing {name, gender, persona, assigned_voice_id, rationale}."
        )

        phase1_prompt = (
            f"AVAILABLE VOICES IN STUDIO:\n{voice_library_str}\n\n"
            f"PRIMARY NARRATOR VOICE ID: {narrator_voice_id}\n\n"
            f"CHAPTER MANUSCRIPT SAMPLE:\n{text_sample}\n\n"
            "Return JSON in this format:\n"
            "{\n"
            '  "characters": [\n'
            '    {"name": "Narrator", "gender": "neutral", "assigned_voice_id": "' + narrator_voice_id + '", "persona": "Storyteller"},\n'
            '    {"name": "Character Name", "gender": "male/female", "assigned_voice_id": "voice_id", "persona": "brief description"}\n'
            "  ]\n"
            "}"
        )

        print(f"[AIDirector] Running Phase 1 (Character Casting) via {provider}...")
        try:
            p1_raw = self.call_llm(provider, api_key, model, phase1_prompt, phase1_system)
            p1_json = json.loads(p1_raw.strip().strip("`").removeprefix("json").strip())
            discovered_characters = p1_json.get("characters", [])
        except Exception as e:
            print(f"[AIDirector] Phase 1 fallback notice: {e}")
            discovered_characters = [
                {"name": "Narrator", "assigned_voice_id": narrator_voice_id, "persona": "Primary Storyteller"}
            ]

        # Ensure all discovered characters have unique id, color, badge, and voice_id
        palette = [
            "#f59e0b",  # Amber/Gold (Rich Dad / Mentor)
            "#10b981",  # Emerald (Mike / Friend)
            "#ec4899",  # Rose/Pink
            "#8b5cf6",  # Purple
            "#06b6d4",  # Cyan (Author / Youth)
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

        char_map = {c["name"].lower(): c for c in discovered_characters}

        if progress_callback:
            try:
                progress_callback({
                    "step": "cast_ready",
                    "percent": 28,
                    "message": f"Cast established ({len(discovered_characters)} characters). Splitting dialogue & attributing speakers...",
                    "characters": discovered_characters,
                    "total_blocks": len(blocks),
                    "total_chunks": total_chunks,
                    "current_chunk": 0
                })
            except Exception:
                pass

        # Phase 2: Directed Block Generation in safe chunks (25 blocks per chunk to avoid JSON truncation)
        directed_blocks: List[Dict[str, Any]] = []
        block_counter = 1

        phase2_system = (
            "You are a master Audiobook & Audio Drama Dialogue Director.\n"
            "You receive numbered story blocks. Your job is to:\n"
            "1. STRICT DIALOGUE RULE: ONLY text inside quotation marks (\"...\" or “...”) may be attributed to a speaking character!\n"
            "2. ALL dialogue tags, narrative descriptions, and action beats OUTSIDE quotation marks (e.g. 'Ray asked,', 'he whispered.', 'Ray chuckled.', 'No one answered, so Ray asked again,', 'The students laughed again, and finally one brave soul yelled out,') MUST be placed in a separate block with speaker: 'Narrator' and the Narrator's voice_id.\n"
            "3. NEVER include narrative tags or text outside quotes in a character block.\n"
            "4. Add natural Fish Speech emotion tags for expressive lines: [whisper], [screaming], [panicked], [sinister], [gasping], [cheerful], [angry], [pompous], [sobbing], [confused]. If neutral, emotion_tag is null.\n"
            "5. PRESERVE EVERY WORD of the original author's text. Do not invent or summarize story content.\n"
            "Output JSON with a 'blocks' array: [{speaker, voice_id, text, emotion_tag}]."
        )

        char_cast_summary = "\n".join([f'- {c["name"]}: Voice ID "{c.get("assigned_voice_id")}" ({c.get("persona")})' for c in discovered_characters])

        for start_idx in range(0, len(blocks), chunk_size):
            chunk_num = (start_idx // chunk_size) + 1
            if progress_callback:
                try:
                    pct = 28 + int(68 * (chunk_num - 1) / total_chunks)
                    progress_callback({
                        "step": "directing",
                        "percent": pct,
                        "message": f"Directing dialogue & acting tags (Chunk {chunk_num} of {total_chunks})...",
                        "characters": discovered_characters,
                        "total_blocks": len(blocks),
                        "total_chunks": total_chunks,
                        "current_chunk": chunk_num
                    })
                except Exception:
                    pass

            chunk = blocks[start_idx:start_idx + chunk_size]
            chunk_input = []
            for idx, b in enumerate(chunk):
                b_text = b.get("text", "").strip()
                chunk_input.append(f"[{idx+1}] {b_text}")

            phase2_prompt = (
                f"CASTING DIRECTORY:\n{char_cast_summary}\n\n"
                f"NARRATOR VOICE ID: {narrator_voice_id}\n\n"
                f"CRITICAL RULE: Characters ONLY speak words inside quotation marks (\"...\" or “...”). Words outside quotes belong to Narrator.\n\n"
                f"STORY BLOCKS TO DIRECT:\n" + "\n\n".join(chunk_input) + "\n\n"
                "Return JSON in this exact structure:\n"
                "{\n"
                '  "blocks": [\n'
                '    {"speaker": "Narrator", "voice_id": "' + narrator_voice_id + '", "text": "Ray chuckled.", "emotion_tag": null},\n'
                '    {"speaker": "Ray Kroc", "voice_id": "...", "text": "“That’s what I thought you would say.”", "emotion_tag": "[cheerful]"}\n'
                "  ]\n"
                "}"
            )

            print(f"[AIDirector] Directing batch {start_idx+1} to {min(start_idx+chunk_size, len(blocks))}...")
            try:
                p2_raw = self.call_llm(provider, api_key, model, phase2_prompt, phase2_system)
                p2_json = json.loads(p2_raw.strip().strip("`").removeprefix("json").strip())
                new_sub_blocks = p2_json.get("blocks", [])

                if not new_sub_blocks:
                    raise ValueError("Empty blocks in response")

                for sb in new_sub_blocks:
                    txt = (sb.get("text") or "").strip()
                    if not txt:
                        continue
                    spk = sb.get("speaker") or "Narrator"
                    matched_char = char_map.get(spk.lower())
                    if not matched_char:
                        for k, c in char_map.items():
                            if k in spk.lower() or spk.lower() in k:
                                matched_char = c
                                break
                    if not matched_char:
                        matched_char = char_map.get("narrator", discovered_characters[0])

                    spk_name = matched_char["name"]
                    cid = matched_char["id"]
                    vid = sb.get("voice_id") or matched_char["assigned_voice_id"]
                    etag = sb.get("emotion_tag")

                    # Clean tag if already prefixed in text
                    if etag and txt.startswith(etag):
                        txt = txt[len(etag):].strip()

                    directed_blocks.append({
                        "id": f"b_{block_counter}",
                        "speaker": spk_name,
                        "character_id": cid,
                        "voice_id": vid,
                        "text": txt,
                        "emotion_tag": etag,
                        "pause_after": 0.6 if spk_name.lower() == "narrator" else 0.4
                    })
                    block_counter += 1

            except Exception as batch_err:
                print(f"[AIDirector] Batch direct notice ({batch_err}), preserving original blocks for this batch.")
                narr_char = char_map.get("narrator", discovered_characters[0])
                for b in chunk:
                    directed_blocks.append({
                        "id": f"b_{block_counter}",
                        "speaker": narr_char["name"],
                        "character_id": narr_char["id"],
                        "voice_id": b.get("voice_id") or narr_char["assigned_voice_id"],
                        "text": b.get("text", ""),
                        "emotion_tag": b.get("emotion_tag"),
                        "pause_after": b.get("pause_after", 0.6)
                    })
                    block_counter += 1

        # Guarantee strict separation of character quotes from narrator attribution tags
        narr_char = char_map.get("narrator", discovered_characters[0])
        if split_dialogue and directed_blocks:
            directed_blocks = self.sanitize_and_split_dialogue(directed_blocks, narr_char, char_map)

        if progress_callback:
            try:
                progress_callback({
                    "step": "done",
                    "percent": 100,
                    "message": f"Directing complete! Cast {len(discovered_characters)} characters across {len(directed_blocks)} speech blocks.",
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
