"""
================================================================================
🐟 FISH AUDIO S2 PRO / 1.5 — COMPLETE 1-CLICK NEURAL GPU WORKER
================================================================================
Runs on Google Colab (Tesla T4 / A100 GPU).
1. Auto-installs Fish Speech and downloads the 2.5 GB official neural weights.
2. Loads the model directly into NVIDIA GPU VRAM.
3. Spawns a secure Cloudflare tunnel directly to the neural server.
================================================================================
"""

import os
import sys
import time
import socket
import subprocess

print("=" * 76)
print("🐟 Fish Audio S2 Pro — Complete 1-Click Neural GPU Worker Setup")
print("=" * 76)

# ----------------- 1. SETUP FISH SPEECH & REPOSITORY ----------------- #
print("[1/4] Checking python packages and Fish Speech repository...")
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "pycloudflared", "huggingface_hub"])

if not os.path.exists("fish-speech"):
    print("    📦 Cloning official Fish Speech engine...")
    subprocess.run(["git", "clone", "--depth", "1", "https://github.com/fishaudio/fish-speech.git"])
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-e", "./fish-speech"])
else:
    print("    ✅ Fish Speech repository found.")

# ----------------- 2. CHECK GPU ----------------- #
print("\n[2/4] Verifying GPU acceleration...")
try:
    import torch
    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0)
        vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        print(f"    ✅ GPU Active: {gpu_name} ({vram_gb:.2f} GB VRAM)")
    else:
        print("    ⚠️ No CUDA GPU detected! Switch to GPU in Runtime -> Change runtime type.")
        gpu_name = "CPU"
except Exception as e:
    print(f"    ⚠️ PyTorch note: {e}")
    gpu_name = "CPU"

# ----------------- 3. DOWNLOAD NEURAL MODEL WEIGHTS ----------------- #
print("\n[3/4] Checking official Neural Model weights...")
CHECKPOINT_DIR = "fish-speech/checkpoints/fish-speech-1.5"
CODEC_FILE = os.path.join(CHECKPOINT_DIR, "firefly-gan-vq-fsq-8x1024-21hz-generator.pth")

if not os.path.exists(CODEC_FILE):
    print("    📥 Downloading Real Neural Model Weights from Hugging Face (~2.5 GB)...")
    from huggingface_hub import snapshot_download
    snapshot_download(
        repo_id="fishaudio/fish-speech-1.5",
        local_dir=CHECKPOINT_DIR
    )
    print("    ✅ Download complete! Neural weights saved to", CHECKPOINT_DIR)
else:
    print("    ✅ Neural weights already downloaded and cached!")

# ----------------- 4. LAUNCH NATIVE FISH SPEECH SERVER & TUNNEL ----------------- #
PORT = 8080

def free_port(p):
    try:
        subprocess.run(f"fuser -k {p}/tcp 2>/dev/null", shell=True)
        time.sleep(1)
    except Exception:
        pass

free_port(PORT)

print(f"\n[4/4] Launching Fish Speech Neural API Server on port {PORT}...")
cmd = [
    sys.executable, "tools/api_server.py",
    "--listen", f"0.0.0.0:{PORT}",
    "--llama-checkpoint-path", "checkpoints/fish-speech-1.5",
    "--decoder-checkpoint-path", "checkpoints/fish-speech-1.5/firefly-gan-vq-fsq-8x1024-21hz-generator.pth",
    "--decoder-config-name", "firefly_gan_vq"
]

server_proc = subprocess.Popen(
    cmd,
    cwd="fish-speech"
)

print("    ⏳ Allocating neural weights into GPU VRAM (waiting ~15s)...")
time.sleep(15)

# Spawn Cloudflare Tunnel
from pycloudflared import try_cloudflare
print("🌐 Establishing Cloudflare HTTPS secure tunnel...")
tunnel = try_cloudflare(port=PORT)
tunnel_url = getattr(tunnel, "tunnel", str(tunnel)).strip()

print("\n" + "=" * 74)
print("  🎉 REAL NEURAL FISH SPEECH ENGINE IS NOW ONLINE!")
print("=" * 74)
print(f"  ⚡ GPU Hardware:   {gpu_name}")
print(f"  ⚡ Neural Model:   fishaudio/fish-speech-1.5 (Real Voices)")
print(f"  🌐 TUNNEL URL:    {tunnel_url}")
print("=" * 74)
print("  📋 NEXT STEP:")
print("  1. Copy the TUNNEL URL above.")
print("  2. Open Studio (http://localhost:7865) -> Cloud GPU.")
print("  3. Paste into Tunnel URL -> Click '⚡ Test Connection' -> 'Save & Activate'.")
print("=" * 74 + "\n")

try:
    while True:
        time.sleep(60)
except KeyboardInterrupt:
    server_proc.terminate()
    print("\n[!] Worker stopped.")
