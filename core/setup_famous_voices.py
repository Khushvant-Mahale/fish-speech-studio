"""
Download and curate famous celebrity & character voice reference audios for Fish Speech S2 Pro.
"""

import sys
import io
import urllib.request
import numpy as np
import soundfile as sf
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
VOICES_DIR = BASE_DIR / "voices" / "reference"
VOICES_DIR.mkdir(parents=True, exist_ok=True)

sources = [
    ("attenborough.wav", "https://huggingface.co/drewThomasson/fineTunedTTSModels/resolve/main/xtts-v2/eng/DavidAttenborough/DavidAttenborough_24khz.wav"),
    ("morgan_freeman.wav", "https://huggingface.co/drewThomasson/fineTunedTTSModels/resolve/main/xtts-v2/eng/MorganFreeman/MorganFreeman_24khz.wav"),
    ("scarlett_johansson.wav", "https://huggingface.co/drewThomasson/fineTunedTTSModels/resolve/main/xtts-v2/eng/ScarlettJohansson/ScarlettJohansson_24000.wav"),
    ("walter_white.wav", "https://huggingface.co/drewThomasson/fineTunedTTSModels/resolve/main/xtts-v2/eng/BryanCranston/BryanCranston_24khz.wav"),
    ("geralt_witcher.wav", "https://huggingface.co/jbetker/tortoise-tts-v2/resolve/main/tortoise/voices/geralt/1.wav"),
    ("emma_watson.wav", "https://huggingface.co/jbetker/tortoise-tts-v2/resolve/main/tortoise/voices/emma/1.wav"),
    ("ghost_mw2.wav", "https://huggingface.co/drewThomasson/fineTunedTTSModels/resolve/main/xtts-v2/eng/GhostMW2/GhostMW2_24khz.wav"),
    ("death_wolf.wav", "https://huggingface.co/drewThomasson/fineTunedTTSModels/resolve/main/xtts-v2/eng/DeathPussInBoots/DeathPussInBoots_24khz.wav"),
    ("bob_ross.wav", "https://huggingface.co/drewThomasson/fineTunedTTSModels/resolve/main/xtts-v2/eng/BobRoss/BobRoss_24khz.wav"),
    ("saul_goodman.wav", "https://huggingface.co/drewThomasson/fineTunedTTSModels/resolve/main/xtts-v2/eng/BobOdenkirk/BobOdenkirk_24khz.wav"),
    ("stanley_narrator.wav", "https://huggingface.co/drewThomasson/fineTunedTTSModels/resolve/main/xtts-v2/eng/StanleyParable/StanleyParable_24000.wav"),
    ("robert_deniro.wav", "https://huggingface.co/jbetker/tortoise-tts-v2/resolve/main/tortoise/voices/deniro/1.wav"),
]

def main():
    print("[Famous Voices] Starting download of 12 iconic voices...")
    success_count = 0
    for filename, url in sources:
        dest = VOICES_DIR / filename
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=25) as resp:
                audio_bytes = resp.read()
            data, sr = sf.read(io.BytesIO(audio_bytes))
            if data.ndim > 1:
                data = data.mean(axis=1)
            # Resample to 24000 if needed
            if sr != 24000:
                try:
                    import scipy.signal
                    num_samples = int(len(data) * 24000 / sr)
                    data = scipy.signal.resample(data, num_samples)
                except Exception:
                    # Fallback linear interpolation
                    old_indices = np.linspace(0, len(data), len(data))
                    new_indices = np.linspace(0, len(data), int(len(data) * 24000 / sr))
                    data = np.interp(new_indices, old_indices, data)
                sr = 24000

            # Trim to max 5.5s
            max_samples = int(5.5 * 24000)
            if len(data) > max_samples:
                data = data[:max_samples]

            # Peak normalize
            peak = np.max(np.abs(data))
            if peak > 0:
                data = (data / peak) * 0.92

            sf.write(str(dest), data.astype(np.float32), 24000)
            dur = round(len(data) / 24000, 2)
            print(f"SUCCESS: {filename} ({dur}s @ {sr}Hz)")
            success_count += 1
        except Exception as e:
            print(f"ERROR: {filename} failed: {e}")

    print(f"[Famous Voices] Finished: {success_count}/{len(sources)} voices successfully saved.")

if __name__ == "__main__":
    main()
