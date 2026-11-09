import re
from pathlib import Path

# Paths
INPUT_SCRIPT = Path(r"c:\Users\ADMIN\Documents\Project Folder\Make\Projects\Stuck in School\THE SCHOOL WHERE TIME STOPPED.txt")
OUTPUT_FILE = Path(r"c:\Users\ADMIN\Documents\Project Folder\Make\Projects\Stuck in School\storyboard_prompts.md")

# Character Seed Tags (with dynamic emotional hook placeholder)
TAG_DANIEL_BASE = "17-year-old boy, black messy hair, round black-rimmed glasses, dark oversized hoodie, simple comic ink features"
TAG_LUCY_BASE = "17-year-old girl, long straight dark hair, pleated navy school skirt, white collared shirt, thin silver chain bracelet on wrist, pale unblemished skin"

STYLE_TAIL = "2D dark graphic novel style, indie comic book illustration, gritty analog horror aesthetic, sharp black ink outlines, cel-shaded, muted desaturated colors, deep dramatic shadows, high contrast, 4k --ar 16:9 --v 6.1"

SHOT_TYPES = [
    "Extreme Close-Up (ECU)",
    "First-Person POV",
    "Dutch Angle / Low-Angle",
    "Over-The-Shoulder (OTS)",
    "Wide Establishing Shot",
    "Dynamic Action Profile"
]

def get_scene_context(scene_num):
    contexts = {
        1: {
            "name": "NORMALITY SHATTERS",
            "loc": "busy high school hallway transitioning to exterior front steps",
            "light": "warm golden afternoon sunlight abruptly dying into eerie silence",
            "early_mood": "calm, relaxed, ordinary, casual everyday school atmosphere",
            "late_mood": "creeping bewilderment, chilling dread, startled shock as crowd vanishes"
        },
        2: {
            "name": "THE TWISTING SKY",
            "loc": "school perimeter fence and deserted street",
            "light": "violent bruised overcast sky, flickering darkness, ground tremors",
            "mood": "uneasy curiosity turning into escalating terror, dreading unnatural storm"
        },
        3: {
            "name": "THE SEALED DOORS",
            "loc": "locked school entrance vestibule and dark corridor",
            "light": "smartphone flashlight beam cutting through pitch-black darkness",
            "mood": "frantic claustrophobic panic, desperate adrenaline, breathless fear"
        },
        4: {
            "name": "THE GIRL WHO DISAPPEARED",
            "loc": "shadowy hallway illuminated by single flashlight beam",
            "light": "circular flashlight beam on school lockers and tiles, deep shadows",
            "mood": "spine-chilling disbelief, stunned shock, profound emotional sorrow"
        },
        5: {
            "name": "THE GREY MIST",
            "loc": "main entrance doorway opened to an infinite void",
            "light": "flat diffuse cold grey glow from infinite mist, zero horizon",
            "mood": "vertiginous awe, creeping hopeless dread, uncanny numbness"
        },
        6: {
            "name": "3:17",
            "loc": "principal's office, dark desk, wall clock",
            "light": "dim phone flashlight beam illuminating frozen clock face at 3:17",
            "mood": "suspicious tension, eerie quietude, startled jolt as clock ticks"
        },
        7: {
            "name": "THE ATTENDANCE SHEET",
            "loc": "principal's office, mechanical printer humming",
            "light": "flickering green fluorescent overhead tube, printer slot glow",
            "mood": "baffled apprehension, cold dread reading sinister warning"
        },
        8: {
            "name": "THE ANNOUNCEMENT",
            "loc": "principal's office, ceiling PA speaker crackling",
            "light": "strobing fluorescent tubes, clock hands jerking backward",
            "mood": "unsettling psychological disturbance, Lucy trembling in pale horror"
        },
        9: {
            "name": "ECHOES OF THE PAST",
            "loc": "principal's office window looking into hallway",
            "light": "spectral golden memory light vs dark office silhouette",
            "mood": "nostalgic melancholy, overwhelming emotional breakthrough, crying"
        },
        10: {
            "name": "THE LANDLINE CALL",
            "loc": "beneath principal's wooden desk, analog telephone",
            "light": "amber backlit caller ID, deep shadows under desk",
            "mood": "desperate yearning and tears shifting to blood-curdling demonic dread"
        },
        11: {
            "name": "ONE PRESENT, ONE DISMISSED",
            "loc": "principal's desk, open brass lever mechanism drawer",
            "light": "faint crimson glow from lever slots, flashlight beam",
            "mood": "grim analytical realization, rising panic rejecting the cruel trade"
        },
        12: {
            "name": "ROLL CALL",
            "loc": "corridor outside principal's office, classroom doors",
            "light": "sickly yellow light spilling from classroom windows",
            "mood": "primal paranoia, hurried fear of shadowy watchers"
        },
        13: {
            "name": "THE DESERTED TOWN",
            "loc": "empty asphalt street and closed commercial storefronts",
            "light": "blinking amber traffic signals, glowing school windows behind",
            "mood": "fleeting glimmer of hope crashing into chilling voyeuristic terror"
        },
        14: {
            "name": "THE PHANTOM BUS",
            "loc": "street intersection, idling transit bus",
            "light": "warm incandescent interior bus lighting, street shadows",
            "mood": "surreal heartbreak, existential horror of doomed duplicates, trapped despair"
        },
        15: {
            "name": "UNAUTHORISED RELEASE",
            "loc": "principal's office, manual release lever panel",
            "light": "flashing red alarm strobe, harsh PA feedback glare",
            "mood": "passionate fierce argument, stubborn protective defiance, mutual anguish"
        },
        16: {
            "name": "THE SACRIFICE",
            "loc": "principal's desk, attendance sheet and pen",
            "light": "ethereal faint blue ink glow, ticking clock face",
            "mood": "somber resolute martyrdom, bittersweet heartbreak, tearful loving goodbye"
        },
        17: {
            "name": "THREE CHIMES",
            "loc": "principal's office, fully pulled brass lever",
            "light": "blinding white electrical flare, flashing hallway",
            "mood": "cathartic explosive power, trembling finality, reality-shattering release"
        },
        18: {
            "name": "THE RETURN OF THE WORLD",
            "loc": "school main entrance, threshold to outside world",
            "light": "radiant natural golden afternoon sunshine, vibrant street",
            "mood": "overjoyed weeping relief, tearful euphoria reconnecting with home"
        },
        19: {
            "name": "THE THRESHOLD",
            "loc": "glass double doors entrance, physical barrier",
            "light": "sunlit exterior vs dark interior abyss",
            "mood": "agonizing separation, frantic tear-streaked desperation pounding on glass"
        },
        20: {
            "name": "3:18",
            "loc": "silent dark school corridor, principal's office",
            "light": "monochrome darkness, single distant clock face tick",
            "mood": "hollow solitary resignation, eerie eerie acceptance of eternal confinement"
        }
    }
    return contexts.get(scene_num, {
        "name": f"Scene {scene_num}",
        "loc": "school interior",
        "light": "dark atmospheric shadows",
        "mood": "tense supernatural horror"
    })

def determine_emotion(scene_num, sent_idx, text, char_id):
    lower = text.lower()
    
    # Scene 1 progression: starts calm/ordinary, only gets shocked near sentence 10+
    if scene_num == 1:
        if sent_idx <= 8:
            return "calm and relaxed, neutral everyday expression, unconcerned, casual demeanor"
        elif sent_idx in [9, 10]:
            return "confused curiosity, mildly puzzled look, slowing down"
        else:
            return "eyes widening in sudden bewildered shock, startled disbelief, uneasy and alarmed"

    # Specific emotional triggers
    if any(w in lower for w in ["tear", "crying", "sob", "wept", "mum", "mother"]):
        return "deeply emotional, tears streaming down pale cheeks, trembling lips, heartbroken vulnerability"
    if any(w in lower for w in ["scream", "panic", "slam", "shriek", "desperate", "pound", "no!"]):
        return "frantic terrified panic, wide hyper-dilated eyes, hyperventilating, raw adrenaline"
    if any(w in lower for w in ["angry", "dare", "frown", "stop!", "hate"]):
        return "intensely defiant and angry, furrowed brows, passionate sorrow, gritted teeth"
    if any(w in lower for w in ["whisper", "breathes", "quietly", "faintly"]):
        return "hushed and secretive, wide cautious eyes, soft breathy suspense, anxious dread"
    if any(w in lower for w in ["smile", "won't", "make sure you get home", "protect", "nod"]):
        return "bittersweet gentle resolve, sad brave smile, noble self-sacrificing acceptance"
    if any(w in lower for w in ["frozen", "paralyzed", "motionless", "stop", "locked"]):
        return "petrified with cold terror, rigid posture, stunned blank dread, breath hitched"
    if any(w in lower for w in ["disappeared", "missing", "year", "how", "impossible"]):
        return "staggered cognitive shock, disbelieving stare, furrowed brow of pure perplexity"

    # Default scene-level mood
    ctx = get_scene_context(scene_num)
    return ctx.get("mood", "tense anxiety, watchful and uneasy")

def clean_action_phrase(text):
    t = text.strip('"“”').rstrip(',')
    t = re.sub(r'^(Finally,\s*she\s*whispers|She\s*whispers|You\s*say|A\s*teacher\s*calls\s*out)[,:]?\s*', '', t, flags=re.I)
    t = t.strip(' .!?,')
    return t

def build_prompt_core(shot_type, text, char_id, scene_num, sent_idx):
    ctx = get_scene_context(scene_num)
    loc = ctx["loc"]
    light = ctx["light"]
    action = clean_action_phrase(text)
    lower = text.lower()
    
    emotion = determine_emotion(scene_num, sent_idx, text, char_id)
    
    tag_daniel = f"{TAG_DANIEL_BASE}, emotion: {emotion}"
    tag_lucy = f"{TAG_LUCY_BASE}, emotion: {emotion}"

    has_lucy = ("lucy" in lower or char_id == "char_lucy" or 
                any(w in lower for w in ["she", "her", "bracelet", "girl"]))
    has_daniel = (char_id in ["char_hero", "char_na"] or 
                  any(w in lower for w in ["you", "your", "myself", "i "]))

    if shot_type == "Extreme Close-Up (ECU)":
        if "bracelet" in lower:
            return f"Extreme close-up of a delicate thin silver chain bracelet glinting on a pale wrist, ({tag_lucy}), {light}"
        elif "glass" in lower or "chair" in lower or "window" in lower or "crack" in lower or "scratch" in lower:
            return f"Extreme close-up of smooth unblemished reinforced door glass reflecting light with zero scratches or cracks, {light}"
        elif "phone" in lower or "signal" in lower or "date" in lower or "caller" in lower or "3:17" in lower or "3:18" in lower or "clock" in lower:
            return f"Extreme close-up of screen or clock face displaying '{action}', trembling fingers showing intense anxiety, {light}"
        elif "lever" in lower or "bell" in lower or "panel" in lower:
            return f"Extreme close-up of an ornate tarnished brass manual bell release lever seated inside an iron slot, ominous atmosphere, {light}"
        elif "sheet" in lower or "ink" in lower or "attendance" in lower or "name" in lower or "present" in lower or "dismissed" in lower:
            return f"Extreme close-up of thick black ink shifting and crossing out names on the attendance sheet, eerie supernatural movement, {light}"
        elif has_lucy and not has_daniel:
            return f"Extreme close-up of Lucy's face, displaying {emotion}, ({tag_lucy}), {light}"
        else:
            if scene_num == 1 and sent_idx <= 8:
                return f"Extreme close-up of Daniel's face with a casual calm expression behind round black-rimmed glasses, ({tag_daniel}), {light}"
            return f"Extreme close-up of Daniel's face showing {emotion}, round black-rimmed glasses reflecting dark shadows, ({tag_daniel}), {light}"

    elif shot_type == "First-Person POV":
        if "flashlight" in lower or "dark" in lower or "corridor" in lower or "shadow" in lower:
            return f"First-person POV holding a bright smartphone flashlight beam cutting into the pitch-black {loc}, illuminating '{action}', feeling of {emotion}, {light}"
        elif "door" in lower or "handle" in lower or "lock" in lower:
            return f"First-person POV extending a trembling hand toward the heavy steel entrance handle in the {loc}, sensation of {emotion}, {light}"
        elif "mist" in lower or "void" in lower:
            return f"First-person POV looking past the doorway into an infinite flat void of grey mist, zero horizon, feeling of chilling isolation, {light}"
        elif has_lucy:
            return f"First-person POV looking directly across at Lucy ({tag_lucy}) in the {loc}, reacting with {emotion}, illuminated by {light}"
        elif "desk" in lower or "paper" in lower or "sheet" in lower:
            return f"First-person POV looking down at the wooden desk where the attendance sheet lies, feeling of {emotion}, {light}"
        elif "bus" in lower:
            return f"First-person POV staring across the asphalt road at the brightly illuminated interior of an eerie transit bus, feeling of {emotion}, {light}"
        else:
            return f"First-person POV surveying the {loc}, witnessing '{action}', experiencing {emotion}, {light}"

    elif shot_type == "Dutch Angle / Low-Angle":
        if "sky" in lower or "cloud" in lower or "thunder" in lower or "roof" in lower:
            return f"Severe low-angle Dutch tilt from pavement looking up at Daniel ({tag_daniel}) dwarfed by colossal dark spiraling clouds, displaying {emotion}, {light}"
        elif "chair" in lower:
            return f"Dramatic low-angle Dutch shot of Daniel ({tag_daniel}) rearing back with a heavy wooden classroom chair mid-swing, fueled by desperate adrenaline, {light}"
        elif "door" in lower or "entrance" in lower or "locker" in lower:
            return f"Low-angle Dutch tilt looking up from floor tiles at towering locked double doors, sensing {emotion}, {light}"
        elif has_lucy and not has_daniel:
            return f"Low-angle Dutch tilt looking up from floor tiles at Lucy ({tag_lucy}) in the shadowy hallway, visibly {emotion}, {light}"
        elif "lever" in lower:
            return f"Tilted low-angle view looking up from desk level at the ominous brass manual release lever mechanism, heavy suspense, {light}"
        else:
            return f"Low-angle Dutch tilt showing Daniel ({tag_daniel}) in the {loc}, clearly {emotion}, reacting to '{action}', {light}"

    elif shot_type == "Over-The-Shoulder (OTS)":
        if has_lucy and has_daniel:
            return f"Over-the-shoulder behind Daniel ({tag_daniel}) looking forward at Lucy ({tag_lucy}) whose face conveys {emotion} in the {loc}, {light}"
        elif "bus" in lower:
            return f"Over-the-shoulder behind Daniel ({tag_daniel}) staring in shock across the road at the glowing phantom bus doors, {light}"
        elif "desk" in lower or "clock" in lower or "office" in lower:
            return f"Over-the-shoulder behind Daniel ({tag_daniel}) peering with growing tension into the principal's office, {light}"
        elif has_lucy:
            return f"Over-the-shoulder behind Daniel ({tag_daniel}) watching Lucy ({tag_lucy}) looking deeply {emotion}, {light}"
        else:
            return f"Over-the-shoulder shot behind Daniel ({tag_daniel}) experiencing {emotion} as he faces the {loc}, {light}"

    elif shot_type == "Wide Establishing Shot":
        if "mist" in lower or "void" in lower:
            return f"Wide establishing shot of the solitary school building severed in an endless flat expanse of featureless grey mist, profound cosmic loneliness, {light}"
        elif "street" in lower or "town" in lower or "road" in lower:
            return f"Wide establishing shot of dead silent asphalt streets, dark shut storefronts, blinking amber traffic lights, overwhelming eerie desolation, {light}"
        elif "classroom" in lower or "silhouette" in lower:
            return f"Wide establishing shot down the cavernous school hallway, yellow light beaming from classroom doorways showing seated dark silhouettes, spine-tingling paranoia, {light}"
        elif "office" in lower or "desk" in lower:
            return f"Wide establishing shot of the messy vintage principal's office, papers strewn, dark computer, wall clock, thick heavy suspense, illuminated by {light}"
        else:
            if scene_num == 1 and sent_idx <= 8:
                return f"Wide establishing shot of the crowded school hallway with laughing and chatting students, lively ordinary school atmosphere, warm golden sunlight"
            return f"Wide establishing shot of the vast empty {loc}, lone figures dwarfed by cavernous architecture, palpable feeling of {emotion}, {light}"

    elif shot_type == "Dynamic Action Profile":
        if "run" in lower or "sprint" in lower or "rush" in lower or "move" in lower:
            return f"Dynamic side profile of Daniel ({tag_daniel}) sprinting urgently through the {loc}, posture driven by {emotion}, hoodie billowing, {light}"
        elif "pull" in lower or "lever" in lower:
            return f"Dynamic side profile of Daniel ({tag_daniel}) leaning back with full body weight pulling the heavy brass lever, teeth gritted in desperate determination, {light}"
        elif has_lucy and ("grab" in lower or "hold" in lower or "touch" in lower or "hand" in lower):
            return f"Side profile of Daniel ({tag_daniel}) and Lucy ({tag_lucy}) facing each other, expressions filled with {emotion}, hands reaching, {light}"
        elif "door" in lower or "slam" in lower or "glass" in lower:
            return f"Side profile of Daniel ({tag_daniel}) thrown against the sealed entrance doors, face contorted in frantic desperation, {light}"
        else:
            return f"Dynamic action side profile of Daniel ({tag_daniel}) navigating through the {loc}, displaying clear {emotion}, {light}"

    return f"Cinematic shot of Daniel ({tag_daniel}) in the {loc}, clearly {emotion}, portraying '{action}', {light}"

def generate_all_storyboard_prompts():
    import build_kashva_project
    blocks = build_kashva_project.parse_script_to_blocks()

    output_lines = [
        "# STORYBOARD PROMPT SPECIFICATION",
        "## Series: The School Where Time Stopped (@danieltells)",
        "### Complete Sentence-by-Sentence AI Image Prompts (Scenes 1 - 20)",
        "",
        "> **Production & Emotion Directive:**",
        "> - Includes explicit, nuanced character emotions for every frame (calm/natural at start, shifting to baffled shock, creeping dread, frantic terror, heartbreaking tears, and somber resolve).",
        "> - Strict alternating 6-camera rotation cycle with zero consecutive angle repetitions.",
        "> - Fixed character consistency seed tags for Daniel and Lucy.",
        "",
        "---",
        ""
    ]

    current_scene = 1
    sentence_idx = 1
    global_shot_idx = 0

    scene_sentence_counts = {}

    for b in blocks:
        if b.get("type") == "heading":
            h_text = b.get("text", "")
            m = re.search(r'\[SCENE\s+(\d+):?\s*([^\]]*)\]', h_text)
            if m:
                current_scene = int(m.group(1))
                scene_info = get_scene_context(current_scene)
                scene_title = m.group(2).strip() or scene_info["name"]
                sentence_idx = 1
                output_lines.extend([
                    f"\n## Scene {current_scene}: {scene_title}\n",
                    f"*Location: {scene_info['loc']} | Lighting: {scene_info['light']}*\n",
                    ""
                ])
            continue

        spoken_line = b.get("text", "").strip()
        if not spoken_line:
            continue

        char_id = b.get("character_id", "char_na")
        shot_type = SHOT_TYPES[global_shot_idx % len(SHOT_TYPES)]
        global_shot_idx += 1

        prompt_core = build_prompt_core(shot_type, spoken_line, char_id, current_scene, sentence_idx)
        full_prompt = f"`{prompt_core}, {STYLE_TAIL}`"

        output_lines.extend([
            f"**[Scene {current_scene} - Sentence {sentence_idx}]**",
            f"* **Spoken Line:** \"{spoken_line}\"",
            f"* **Shot Type:** {shot_type}",
            f"* **Prompt:** {full_prompt}",
            ""
        ])

        scene_sentence_counts[current_scene] = sentence_idx
        sentence_idx += 1

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(output_lines))

    print(f"[OK] Generated {global_shot_idx} prompts with tailored character emotions across {len(scene_sentence_counts)} scenes.")
    print(f"[OK] Saved to: {OUTPUT_FILE}")

if __name__ == "__main__":
    generate_all_storyboard_prompts()
