import os
import re
import json
import time
import urllib.request
import urllib.error
from typing import List, Dict, Any, Optional

class AIDirector:
    """
    Intelligent LLM-powered Story Director & Character Casting Engine.
    Supports Google Gemini (2.0 Flash / 1.5 Flash), Groq, OpenAI, and Local Ollama.
    """

    DEFAULT_MODELS = {
        "gemini": "gemini-2.0-flash",
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
    def _call_gemini_api(api_key: str, model: str, prompt: str, system_prompt: str = "") -> str:
        """Calls Google Gemini API via lightweight standard REST."""
        model_name = model or "gemini-2.0-flash"
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
        
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
                raise ValueError("Empty or malformed response from Gemini API.")
        except urllib.error.HTTPError as he:
            err_body = he.read().decode("utf-8", errors="ignore")
            try:
                err_json = json.loads(err_body)
                msg = err_json.get("error", {}).get("message", err_body)
            except Exception:
                msg = err_body
            raise RuntimeError(f"Gemini API Error (HTTP {he.code}): {msg}")

    def test_api_key(self, provider: str, api_key: str, model: str = "") -> Dict[str, Any]:
        """Verifies API key with the provider using a minimal ping."""
        target_model = model or self.DEFAULT_MODELS.get(provider, "")
        try:
            if provider == "gemini":
                # Quick ping to Gemini
                self._call_gemini_api(
                    api_key=api_key,
                    model=target_model,
                    prompt='Reply with JSON: {"status": "ok"}',
                    system_prompt="Return valid JSON."
                )
            elif provider == "groq":
                self._call_groq_api(
                    api_key=api_key,
                    model=target_model,
                    prompt='Reply with JSON: {"status": "ok"}',
                    system_prompt="Return valid JSON."
                )
            elif provider == "openai":
                self._call_openai_api(
                    api_key=api_key,
                    model=target_model,
                    prompt='Reply with JSON: {"status": "ok"}',
                    system_prompt="Return valid JSON."
                )
            elif provider == "ollama":
                self._call_ollama_api(
                    model=target_model,
                    prompt='Reply with JSON: {"status": "ok"}',
                    system_prompt="Return valid JSON."
                )
            else:
                return {"ok": False, "error": f"Unknown provider: {provider}"}
            return {"ok": True, "message": f"{provider.capitalize()} API key is valid and connected ({target_model})"}
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
        default_narrator_voice: str = ""
    ) -> Dict[str, Any]:
        """
        Takes raw story blocks and casts characters with voices, splits dialogue from narration,
        and assigns Fish Speech emotion tags.
        """
        if not blocks:
            return {"ok": False, "error": "No blocks provided to direct."}

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

        char_map = {c["name"].lower(): c.get("assigned_voice_id", narrator_voice_id) for c in discovered_characters}
        char_map["narrator"] = narrator_voice_id

        # Phase 2: Directed Block Generation in safe chunks (25 blocks per chunk to avoid JSON truncation)
        chunk_size = 25
        directed_blocks: List[Dict[str, Any]] = []
        block_counter = 1

        phase2_system = (
            "You are a professional Audiobook Dialogue Director.\n"
            "You receive numbered story blocks. Your job is to:\n"
            "1. Separate character dialogue from narrative tags if split_dialogue is enabled.\n"
            "2. Attribute each spoken line to the correct character speaker from the Cast List.\n"
            "3. Assign the character's voice_id.\n"
            "4. Add natural Fish Speech emotion tags for expressive lines: [whisper], [screaming], [panicked], [sinister], [gasping], [cheerful], [angry], [pompous], [sobbing], [confused]. If neutral, emotion_tag is null.\n"
            "5. PRESERVE EVERY WORD of the original author's text. Do not invent or summarize story content.\n"
            "Output JSON with a 'blocks' array: [{speaker, voice_id, text, emotion_tag}]."
        )

        char_cast_summary = "\n".join([f'- {c["name"]}: Voice ID "{c.get("assigned_voice_id")}" ({c.get("persona")})' for c in discovered_characters])

        for start_idx in range(0, len(blocks), chunk_size):
            chunk = blocks[start_idx:start_idx + chunk_size]
            chunk_input = []
            for idx, b in enumerate(chunk):
                b_text = b.get("text", "").strip()
                chunk_input.append(f"[{idx+1}] {b_text}")

            phase2_prompt = (
                f"CASTING DIRECTORY:\n{char_cast_summary}\n\n"
                f"NARRATOR VOICE ID: {narrator_voice_id}\n\n"
                f"STORY BLOCKS TO DIRECT:\n" + "\n\n".join(chunk_input) + "\n\n"
                "Return JSON in this exact structure:\n"
                "{\n"
                '  "blocks": [\n'
                '    {"speaker": "Narrator", "voice_id": "' + narrator_voice_id + '", "text": "block text", "emotion_tag": null},\n'
                '    {"speaker": "Uncle Vernon", "voice_id": "...", "text": "[angry] Don\'t you dare!", "emotion_tag": "[angry]"}\n'
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
                    vid = sb.get("voice_id") or char_map.get(spk.lower(), narrator_voice_id)
                    etag = sb.get("emotion_tag")

                    # Clean tag if already prefixed in text
                    if etag and txt.startswith(etag):
                        txt = txt[len(etag):].strip()

                    directed_blocks.append({
                        "id": f"b_{block_counter}",
                        "speaker": spk,
                        "voice_id": vid,
                        "text": txt,
                        "emotion_tag": etag,
                        "pause_after": 0.6 if spk.lower() == "narrator" else 0.4
                    })
                    block_counter += 1

            except Exception as batch_err:
                print(f"[AIDirector] Batch direct notice ({batch_err}), preserving original blocks for this batch.")
                for b in chunk:
                    directed_blocks.append({
                        "id": f"b_{block_counter}",
                        "speaker": "Narrator",
                        "voice_id": b.get("voice_id") or narrator_voice_id,
                        "text": b.get("text", ""),
                        "emotion_tag": b.get("emotion_tag"),
                        "pause_after": b.get("pause_after", 0.6)
                    })
                    block_counter += 1

        return {
            "ok": True,
            "provider": provider,
            "characters": discovered_characters,
            "total_blocks": len(directed_blocks),
            "blocks": directed_blocks,
            "summary": f"Directing complete! Cast {len(discovered_characters)} characters across {len(directed_blocks)} speech blocks."
        }
