"""
================================================================================
🐟 FISH AUDIO S2 PRO / 1.5 — COMPLETE 1-CLICK NEURAL GPU WORKER
================================================================================
Runs on Google Colab (Tesla T4 / A100 GPU).
1. Auto-installs Fish Speech and verifies the 2.5 GB official neural weights.
2. Spawns Cloudflare tunnel and prints your tunnel URL immediately.
3. Loads the real neural model into NVIDIA GPU VRAM and streams real cloned voices!
================================================================================
"""

import os
import sys
import time
import socket
import shutil
import subprocess
from pathlib import Path

print("=" * 76)
print("🐟 Fish Audio S2 Pro — Complete 1-Click Neural GPU Worker")
print("=" * 76)

# ----------------- 1. SETUP FISH SPEECH & REPOSITORY ----------------- #
print("[1/4] Setting up runtime libraries & Fish Speech...")
runtime_pkgs = [
    "pycloudflared", "huggingface_hub", "pyrootutils", "loguru",
    "kui", "uvicorn", "tiktoken", "hydra-core", "einops",
    "ormsgpack", "soundfile", "natsort", "vector-quantize-pytorch",
    "lightning", "librosa"
]
subprocess.run([sys.executable, "-m", "pip", "install", "-q", *runtime_pkgs])

if not os.path.exists("fish-speech"):
    print("    📦 Cloning official Fish Speech engine...")
    subprocess.run(["git", "clone", "--depth", "1", "https://github.com/fishaudio/fish-speech.git"])

# Install fish-speech in editable mode WITHOUT compiling dependencies (takes 0.5s)
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--no-deps", "-e", "./fish-speech"])
print("    ✅ Fish Speech engine ready.")

# ----------------- 2. CHECK GPU ----------------- #
print("\n[2/4] Verifying GPU acceleration...")
try:
    import torch
    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0)
        vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        print(f"    ✅ GPU Active: {gpu_name} ({vram_gb:.2f} GB VRAM)")
    else:
        print("    ⚠️ No CUDA GPU detected! (Switch to T4 GPU in Runtime -> Change runtime type)")
        gpu_name = "CPU"
except Exception as e:
    gpu_name = "CPU"

# ----------------- 3. LOCATE / DOWNLOAD NEURAL MODEL WEIGHTS ----------------- #
print("\n[3/4] Verifying Neural Model weights (~2.5 GB)...")
CODEC_FILENAME = "firefly-gan-vq-fsq-8x1024-21hz-generator.pth"
TARGET_CKPT_DIR = os.path.abspath("fish-speech/checkpoints/fish-speech-1.5")
os.makedirs(TARGET_CKPT_DIR, exist_ok=True)

# Search for existing downloaded checkpoints in common Colab locations
found_ckpt = None
for candidate in [
    TARGET_CKPT_DIR,
    os.path.abspath("checkpoints/fish-speech-1.5"),
    "/content/checkpoints/fish-speech-1.5",
    "/content/fish-speech/checkpoints/fish-speech-1.5"
]:
    if os.path.exists(os.path.join(candidate, CODEC_FILENAME)):
        found_ckpt = candidate
        break

if found_ckpt:
    print(f"    ✅ Neural weights found in: {found_ckpt}")
    if found_ckpt != TARGET_CKPT_DIR:
        print(f"    Linking weights to: {TARGET_CKPT_DIR}...")
        for fname in os.listdir(found_ckpt):
            src = os.path.join(found_ckpt, fname)
            dst = os.path.join(TARGET_CKPT_DIR, fname)
            if not os.path.exists(dst):
                try:
                    os.symlink(src, dst)
                except Exception:
                    shutil.copy2(src, dst)
else:
    print("    📥 Downloading Real Neural Model Weights from Hugging Face (~2.5 GB)...")
    from huggingface_hub import snapshot_download
    snapshot_download(
        repo_id="fishaudio/fish-speech-1.5",
        local_dir=TARGET_CKPT_DIR
    )
    print("    ✅ Download complete! Neural weights saved to", TARGET_CKPT_DIR)

# ----------------- 4. DYNAMIC PORT & CLOUDFLARE TUNNEL ----------------- #
print("\n[4/4] Establishing Cloudflare Tunnel & Launching Neural GPU Engine...")

def get_free_port(start_port=8080):
    for p in range(start_port, start_port + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("0.0.0.0", p))
                return p
            except OSError:
                continue
    return start_port

PORT = get_free_port(8080)
print(f"    [*] Port assigned: {PORT}")

from pycloudflared import try_cloudflare
print("    🌐 Spawning encrypted Cloudflare HTTPS secure tunnel...")
tunnel = try_cloudflare(port=PORT)
tunnel_url = getattr(tunnel, "tunnel", str(tunnel)).strip()

print("\n" + "=" * 74)
print("  🎉 REAL NEURAL FISH SPEECH ENGINE IS READY!")
print("=" * 74)
print(f"  ⚡ GPU Hardware:    {gpu_name}")
print(f"  ⚡ Neural Checkpoint: checkpoints/fish-speech-1.5")
print(f"  🌐 TUNNEL URL:      {tunnel_url}")
print("=" * 74)
print("  📋 NEXT STEP:")
print("  1. Copy the TUNNEL URL above right now.")
print("  2. Open Studio (http://localhost:7865) -> Click 'Cloud GPU' in top bar.")
print("  3. Paste into Tunnel URL -> Click '⚡ Test Connection' -> 'Save & Activate'.")
print("=" * 74 + "\n")
print("[*] Starting Fish Speech native API server process in foreground...")

# Run Fish Speech native tools/api_server.py in the foreground with live logs
cmd = [
    sys.executable, "tools/api_server.py",
    "--listen", f"0.0.0.0:{PORT}",
    "--llama-checkpoint-path", TARGET_CKPT_DIR,
    "--decoder-checkpoint-path", os.path.join(TARGET_CKPT_DIR, CODEC_FILENAME),
    "--decoder-config-name", "firefly_gan_vq"
]

try:
    res = subprocess.run(cmd, cwd="fish-speech")
    if res.returncode != 0:
        print(f"\n[!] Server process returned exit code {res.returncode}. Keeping cell alive for inspection...")
        while True:
            time.sleep(60)
except KeyboardInterrupt:
    print("\n[!] Worker stopped by user.")
