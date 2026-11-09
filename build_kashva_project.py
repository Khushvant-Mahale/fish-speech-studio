import json
import re
import uuid
import hashlib
from pathlib import Path
import requests

SCRIPT_PATH = Path(r"C:\Users\ADMIN\Documents\Project Folder\Make\Projects\Stuck in School\THE SCHOOL WHERE TIME STOPPED.txt")
STUDIO_URL = "http://localhost:7860"
EDGE_TTS_DIR = Path(r"C:\Users\ADMIN\Documents\Project Folder\edge tts")
PROJECTS_DIR = EDGE_TTS_DIR / "projects"
CACHE_DIR = EDGE_TTS_DIR / "cache"

# 1. Complete Character Roster Definition
CHARACTERS = [
    {
        "id": "char_na",
        "name": "Narrator",
        "voice_id": "blend_george_onyx",
        "speed": 0.92,
        "gain": 1.0,
        "pause_after": 0.4,
        "pitch_shift": 0.0,
        "warmth": 1.0,
        "clarity": 1.0,
        "reverb": 0.0,
        "fx_filter": "none",
        "radio_fx": False,
        "color": "#8b5cf6",
        "badge": "NA",
        "blend_weights": {
            "bm_george": 0.70,
            "am_onyx": 0.30
        }
    },
    {
        "id": "char_hero",
        "name": "Protagonist (You)",
        "voice_id": "am_michael",
        "speed": 0.90,
        "gain": 1.0,
        "pause_after": 0.5,
        "pitch_shift": 0.0,
        "warmth": 0.0,
        "clarity": 1.0,
        "reverb": 0.0,
        "fx_filter": "none",
        "radio_fx": False,
        "color": "#06b6d4",
        "badge": "YOU"
    },
    {
        "id": "char_lucy",
        "name": "Lucy",
        "voice_id": "af_bella",
        "speed": 0.88,
        "gain": 1.0,
        "pause_after": 0.6,
        "pitch_shift": 0.0,
        "warmth": 0.0,
        "clarity": 1.0,
        "reverb": 0.0,
        "fx_filter": "none",
        "radio_fx": False,
        "color": "#f97316",
        "badge": "LU"
    },
    {
        "id": "char_pa",
        "name": "School PA System",
        "voice_id": "am_onyx",
        "speed": 0.88,
        "gain": 1.0,
        "pause_after": 0.8,
        "pitch_shift": -0.5,
        "warmth": 0.0,
        "clarity": 0.0,
        "reverb": 0.0,
        "fx_filter": "radio",
        "radio_fx": True,
        "color": "#eab308",
        "badge": "PA"
    },
    {
        "id": "char_mother",
        "name": "Mother",
        "voice_id": "af_river",
        "speed": 0.90,
        "gain": 1.0,
        "pause_after": 0.6,
        "pitch_shift": 0.0,
        "warmth": 0.0,
        "clarity": 1.0,
        "reverb": 0.0,
        "fx_filter": "radio",
        "radio_fx": True,
        "color": "#3b82f6",
        "badge": "MO"
    },
    {
        "id": "char_teacher",
        "name": "Teacher",
        "voice_id": "bm_george",
        "speed": 0.88,
        "gain": 1.0,
        "pause_after": 0.8,
        "pitch_shift": 0.0,
        "warmth": 0.0,
        "clarity": 0.0,
        "reverb": 0.15,
        "fx_filter": "none",
        "radio_fx": False,
        "color": "#10b981",
        "badge": "TE"
    },
    {
        "id": "char_entity",
        "name": "The Entity",
        "voice_id": "am_fenrir",
        "speed": 0.74,
        "gain": 1.1,
        "pause_after": 1.2,
        "pitch_shift": -2.5,
        "warmth": 2.0,
        "clarity": 0.0,
        "reverb": 0.15,
        "fx_filter": "demon",
        "radio_fx": False,
        "color": "#ef4444",
        "badge": "EN"
    }
]

CHAR_DICT = {c["id"]: c for c in CHARACTERS}

def assign_character(block, char_id, custom_fx=None, custom_speed=None, custom_pause=None, custom_pitch=None, custom_reverb=None):
    char = CHAR_DICT[char_id]
    block["character_id"] = char["id"]
    block["voice_id"] = char["voice_id"]
    block["speed"] = custom_speed if custom_speed is not None else char["speed"]
    block["gain"] = char["gain"]
    block["pause_after"] = custom_pause if custom_pause is not None else char["pause_after"]
    block["pitch_shift"] = custom_pitch if custom_pitch is not None else char["pitch_shift"]
    block["warmth"] = char["warmth"]
    block["clarity"] = char["clarity"]
    block["reverb"] = custom_reverb if custom_reverb is not None else char["reverb"]
    block["fx_filter"] = custom_fx if custom_fx is not None else char["fx_filter"]
    block["radio_fx"] = char["radio_fx"] if custom_fx is None else (custom_fx == "radio")
    if char.get("blend_weights"):
        block["blend_weights"] = char["blend_weights"]
    else:
        block.pop("blend_weights", None)

def parse_script_to_blocks():
    with open(SCRIPT_PATH, "r", encoding="utf-8") as f:
        lines = [l.strip() for l in f.readlines() if l.strip()]

    # Skip header titles
    start_idx = 0
    if len(lines) > 0 and "THE SCHOOL WHERE TIME STOPPED" in lines[0]:
        start_idx = 1
        if len(lines) > 1 and "Audio Story" in lines[1]:
            start_idx = 2
    lines = lines[start_idx:]

    blocks = []
    block_idx = 1
    heading_idx = 1
    current_scene = 1

    i = 0
    while i < len(lines):
        line = lines[i]

        # 1. Scene heading & combined SFX
        if line.startswith("[SCENE"):
            scene_match = re.search(r'\[SCENE\s+(\d+)', line)
            if scene_match:
                current_scene = int(scene_match.group(1))

            scene_text = line
            if i + 1 < len(lines) and lines[i+1].startswith("[SFX:"):
                sfx_text = lines[i+1]
                i += 1
                heading_text = f"{scene_text} {sfx_text}"
            else:
                heading_text = scene_text

            blocks.append({
                "id": f"h_{uuid.uuid4().hex[:8]}_{heading_idx}",
                "type": "heading",
                "text": heading_text,
                "is_spoken": False,
                "pause_after": 1.0
            })
            heading_idx += 1
            i += 1
            continue

        # 2. Standalone SFX inside a scene
        if line.startswith("[SFX:"):
            blocks.append({
                "id": f"h_{uuid.uuid4().hex[:8]}_{heading_idx}",
                "type": "heading",
                "text": line,
                "is_spoken": False,
                "pause_after": 1.0
            })
            heading_idx += 1
            i += 1
            continue

        if line == "End.":
            i += 1
            continue

        # 3. Look for dialogue enclosed in quotes
        quote_matches = list(re.finditer(r'([\"“][^\"”]+[\"”])', line))

        if quote_matches:
            last_end = 0
            for qm in quote_matches:
                prefix = line[last_end:qm.start()].strip()
                dialogue = qm.group(1).strip()
                last_end = qm.end()

                if prefix:
                    sub_sents = [s.strip() for s in re.split(r'(?<=[.!?])\s+', prefix) if s.strip()]
                    for s in (sub_sents if sub_sents else [prefix]):
                        b = {"id": f"b_{block_idx}", "text": s}
                        assign_character(b, "char_na")
                        blocks.append(b)
                        block_idx += 1

                clean_diag = dialogue.strip('"“”').rstrip(',')

                b_diag = {"id": f"b_{block_idx}", "text": dialogue}

                # Mother
                if (current_scene == 10 and clean_diag in [
                    "Lucy?", "Oh thank God.", "Where have you been? We've been looking everywhere.",
                    "Lucy, you've been missing for a year.", "We searched everywhere. The police said—"
                ]) or (current_scene == 18 and clean_diag in ["Lucy? Lucy, where are you?"]):
                    assign_character(b_diag, "char_mother", custom_fx="radio", custom_speed=0.90)

                # Entity
                elif clean_diag == "One student must remain.":
                    assign_character(b_diag, "char_entity", custom_fx="demon", custom_speed=0.74, custom_pause=1.2, custom_pitch=-2.5)

                # PA System
                elif any(clean_diag.startswith(p) for p in [
                    "Attention, students",
                    "Lucy, please report",
                    "Your parents are waiting",
                    "They have been waiting",
                    "Please report to your assigned",
                    "UNAUTHORISED RELEASE",
                    "One student is still missing"
                ]):
                    assign_character(b_diag, "char_pa", custom_fx="radio", custom_speed=0.88, custom_pause=0.8)

                # Teacher
                elif clean_diag in ["Time to take attendance.", "Let's take attendance."]:
                    assign_character(b_diag, "char_teacher", custom_pause=0.8, custom_reverb=0.15)

                # Protagonist ("You")
                elif (current_scene == 4 and clean_diag == "Lucy?") or clean_diag in [
                    "Lucy, you disappeared.", "You've been missing for a year.", "When?",
                    "Do you remember this?", "When was it taken?", "I don't remember that.",
                    "Maybe this place knows something",
                    "Hello?", "I think this place wants to swap us",
                    "The sheet. The announcement. The bell—",
                    "One present. One dismissed, Lucy.",
                    "Keep moving.", "Help! Please!", "That was you.", "What does that mean?",
                    "Who told you that?", "My house is three blocks away", "Let's go.",
                    "We know exactly what it'll do.", "Lucy, your parents have been waiting a year for you.",
                    "I spent a whole year wondering where you were.", "I'm not leaving you. I'm getting you home."
                ]:
                    assign_character(b_diag, "char_hero", custom_speed=0.90)

                # Lucy
                else:
                    if clean_diag in ["I remember the clouds.", "Dismissed", "Please.", "No"]:
                        assign_character(b_diag, "char_lucy", custom_fx="whisper", custom_speed=0.82)
                    elif clean_diag in [
                        "Don't you dare.", "Then don't leave me here!", "And yours are waiting for you!",
                        "You think I want you to stay here? You think I can just walk out and be okay with that?",
                        "Stop! We don't know what it'll do!"
                    ]:
                        assign_character(b_diag, "char_lucy", custom_fx="none", custom_speed=0.94, custom_pitch=0.4)
                    else:
                        assign_character(b_diag, "char_lucy", custom_fx="none", custom_speed=0.88)

                blocks.append(b_diag)
                block_idx += 1

            suffix = line[last_end:].strip()
            if suffix:
                sub_sents = [s.strip() for s in re.split(r'(?<=[.!?])\s+', suffix) if s.strip()]
                for s in (sub_sents if sub_sents else [suffix]):
                    b = {"id": f"b_{block_idx}", "text": s}
                    assign_character(b, "char_na")
                    blocks.append(b)
                    block_idx += 1

        else:
            # Pure narration: split into distinct sentences
            sents = [s.strip() for s in re.split(r'(?<=[.!?])\s+', line) if s.strip()]
            for s in (sents if sents else [line]):
                b = {"id": f"b_{block_idx}", "text": s}
                assign_character(b, "char_na")
                blocks.append(b)
                block_idx += 1

        i += 1

    # 4. Check for existing audio cache hits
    cached_hits = 0
    for b in blocks:
        if b.get("type") == "heading":
            continue
        clean_text = b["text"].strip()
        voice_id = b.get("voice_id", "blend_george_onyx")
        blend_weights = b.get("blend_weights")
        voice_tag = voice_id
        if blend_weights and voice_id not in ["blend_fenrir_onyx", "blend_adam_onyx", "blend_george_onyx"]:
            voice_tag = "blend_" + "_".join(f"{k}:{v:.2f}" for k, v in sorted(blend_weights.items()))

        speed = float(b.get("speed", 0.92))
        gain = float(b.get("gain", 1.0))
        pitch = float(b.get("pitch_shift", 0.0))
        warmth = float(b.get("warmth", 0.0))
        clarity = float(b.get("clarity", 0.0))
        reverb = float(b.get("reverb", 0.0))
        fx_filter = str(b.get("fx_filter", "none")).strip().lower()

        cache_str = (
            f"{clean_text}__{voice_tag}__{speed:.2f}__{gain:.2f}__"
            f"{pitch:.1f}__{warmth:.1f}__{clarity:.1f}__{reverb:.2f}__{fx_filter}"
        )
        h = hashlib.md5(cache_str.encode("utf-8")).hexdigest()
        cache_file = CACHE_DIR / f"{h}.wav"
        if cache_file.exists():
            b["cachedAudioUrl"] = f"/api/audio/{h}.wav"
            b["cachedSig"] = cache_str
            cached_hits += 1

    print(f"Total blocks created: {len(blocks)} (Cache matches found: {cached_hits})")
    return blocks

def create_and_save_project():
    blocks = parse_script_to_blocks()
    proj_id = "proj_school_time_stopped"
    title = "THE SCHOOL WHERE TIME STOPPED"

    project_data = {
        "id": proj_id,
        "title": title,
        "default_voice": "blend_george_onyx",
        "default_settings": {
            "voice_id": "blend_george_onyx",
            "speed": 0.92,
            "gain": 1.0,
            "pause_after": 0.4,
            "pitch_shift": 0.0,
            "warmth": 1.0,
            "clarity": 1.0,
            "reverb": 0.0,
            "fx_filter": "none",
            "radio_fx": False,
            "blend_weights": {
                "bm_george": 0.70,
                "am_onyx": 0.30
            }
        },
        "default_speed": 0.92,
        "default_gain": 1.0,
        "default_pause": 0.4,
        "default_pitch": 0.0,
        "default_warmth": 1.0,
        "default_clarity": 1.0,
        "default_reverb": 0.0,
        "default_filter": "none",
        "characters": CHARACTERS,
        "blocks": blocks,
        "master_filename": f"{proj_id}_master.wav"
    }

    # 1. Write project file directly to disk in projects/
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    dest_path = PROJECTS_DIR / f"{proj_id}.json"
    with open(dest_path, "w", encoding="utf-8") as f:
        json.dump(project_data, f, indent=2, ensure_ascii=False)
    print(f"[OK] Successfully wrote project file to: {dest_path}")

    # 2. Notify live running API at http://localhost:7860/api/project
    try:
        res = requests.post(f"{STUDIO_URL}/api/project", json=project_data, timeout=5)
        print(f"[API] POST /api/project response: {res.status_code} - {res.text}")
    except Exception as e:
        print(f"[API Note] Could not reach {STUDIO_URL}: {e}")

    return project_data

if __name__ == "__main__":
    proj = create_and_save_project()
    print(f"\n[DONE] Project '{proj['title']}' updated with ID: {proj['id']}")
    print(f"Total blocks: {len(proj['blocks'])}")
