"""
================================================================================
🐟 FISH AUDIO S2 PRO (5B DUAL-AR) — COMPLETE 1-CLICK NEURAL GPU WORKER
================================================================================
Runs on Google Colab (Tesla T4 / A100 / L4 GPU).
1. Cleanly validates / restores pristine torchaudio package.
2. Clones official Fish Speech engine on main branch (supports S2 Pro Dual-AR).
3. Downloads the official 5B parameter weights: fishaudio/s2-pro (~11 GB, ~30s).
4. Loads Dual-AR LLaMA (Slow AR) + Fast AR + DAC Codec into GPU VRAM in FP16 (--half).
5. Spawns encrypted Cloudflare HTTPS secure tunnel.
6. Connects directly to local Story Studio for real-time voice acting with
   native inline bracketed emotion control: [whisper], [scream], [sinister], etc.!
================================================================================
"""

import os
import sys
import time
import socket
import shutil
import glob
import urllib.request
import urllib.error
import threading
import subprocess
import re
from pathlib import Path

print("=" * 76)
print("🐟 Fish Audio S2 Pro (5B Dual-AR) — Complete 1-Click GPU Worker Setup")
print("=" * 76)

# ----------------- 0. RESTORE CLEAN TORCHAUDIO IF PREVIOUSLY MODIFIED ----------------- #
print("\n[0/4] Checking and ensuring clean torchaudio package...")
for ta_init in glob.glob("/usr/local/lib/python*/dist-packages/torchaudio/__init__.py") + \
               glob.glob("/usr/lib/python*/dist-packages/torchaudio/__init__.py") + \
               glob.glob(os.path.join(sys.prefix, "lib", "python*", "site-packages", "torchaudio", "__init__.py")):
    if os.path.exists(ta_init):
        try:
            with open(ta_init, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
            clean_lines = [
                l for l in lines 
                if "hasattr(torchaudio" not in l and "list_audio_backends" not in l 
                and "_lab" not in l and "# Auto-patch" not in l
            ]
            if len(clean_lines) != len(lines):
                with open(ta_init, "w", encoding="utf-8") as f:
                    f.writelines(clean_lines)
                print(f"    ✅ Cleaned corrupt lines from {ta_init}")
        except Exception:
            pass

# Remove any old sitecustomize.py
import site
for sp in site.getsitepackages():
    sc = os.path.join(sp, "sitecustomize.py")
    if os.path.exists(sc):
        try:
            os.remove(sc)
        except Exception:
            pass

# Verify torchaudio imports cleanly without throwing NameError
try:
    import torchaudio
    print(f"    ✅ Torchaudio {torchaudio.__version__} is verified and working.")
except Exception as e:
    print(f"    ⚠️ Reinstalling pristine torchaudio package...")
    subprocess.run([sys.executable, "-m", "pip", "install", "--force-reinstall", "--no-deps", "torchaudio"], check=False)

# ----------------- 1. SETUP REPOSITORY ON MAIN BRANCH (S2 PRO SUPPORT) ----------------- #
print("\n[1/4] Setting up official Fish Speech repository for S2 Pro...")

if not os.path.exists("fish-speech"):
    print("    📦 Cloning official Fish Speech engine (latest main branch)...")
    subprocess.run(["git", "clone", "--depth", "1", "https://github.com/fishaudio/fish-speech.git"])
else:
    print("    🔄 Updating Fish Speech repository to latest main branch...")
    try:
        subprocess.run(["git", "fetch", "--all"], cwd="fish-speech", check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["git", "checkout", "main"], cwd="fish-speech", check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["git", "reset", "--hard", "origin/main"], cwd="fish-speech", check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        print(f"    Notice: {e}")

# Inject a lightweight stub for unused ASR dependency so it loads instantly without 500MB download
for stub_dir in ["fish-speech", os.path.join("fish-speech", "tools")]:
    if os.path.exists(stub_dir):
        stub_path = os.path.join(stub_dir, "funasr.py")
        with open(stub_path, "w", encoding="utf-8") as f:
            f.write("# Stub to avoid downloading 500MB unused ASR models\nclass AutoModel:\n    pass\n")

# Install required neural packages
print("    📦 Installing required neural libraries (~25s)...")
runtime_pkgs = [
    "pycloudflared", "huggingface_hub", "pyrootutils", "loguru",
    "kui>=1.6.0", "uvicorn>=0.30.0", "tiktoken>=0.8.0", "hydra-core>=1.3.2",
    "einops>=0.7.0", "ormsgpack", "soundfile", "natsort>=8.4.0",
    "vector-quantize-pytorch==1.14.24", "lightning>=2.1.0", "librosa>=0.10.1",
    "transformers>=4.45.2", "datasets==2.18.0", "loralib>=0.1.2",
    "einx[torch]==0.2.2", "zstandard>=0.22.0", "opencc-python-reimplemented==0.1.7",
    "silero-vad", "pydantic", "cachetools", "descript-audio-codec"
]
subprocess.run([sys.executable, "-m", "pip", "install", "-q", *runtime_pkgs])

# Link fish-speech into Python environment
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--no-deps", "-e", "./fish-speech"])

# Safe source patches strictly inside fish-speech directory (never touching system packages)
patched_count = 0
for root, _, files in os.walk("fish-speech"):
    for file in files:
        if file.endswith(".py"):
            fpath = os.path.join(root, file)
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    c = f.read()
                dirty = False
                if "list_audio_backends" in c:
                    c = re.sub(r'(\w+)\.list_audio_backends\s*\(\s*\)', "['soundfile']", c)
                    dirty = True
                if "backend=self.backend" in c:
                    c = c.replace("backend=self.backend", "")
                    dirty = True
                if dirty:
                    with open(fpath, "w", encoding="utf-8") as f:
                        f.write(c)
                    patched_count += 1
            except Exception:
                pass
if patched_count:
    print(f"    ✅ Patched {patched_count} source files in Fish Speech repository for audio compatibility.")

# Zero-RAM direct GPU VRAM optimization: prevents 20GB CPU RAM freeze on Colab / Kaggle
# Uses exact-point self-healing replacements for all buffers (causal_mask, freqs_cis, fast_freqs_cis)
for root, _, files in os.walk("fish-speech"):
    for file in files:
        if file == "llama.py":
            fpath = os.path.join(root, file)
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    c = f.read()
                dirty = False

                # 1. Meta-device model initialization (0 MB CPU RAM)
                old_init = "model = model_cls(config)"
                new_init = (
                    "import torch\n"
                    "        if torch.cuda.is_available():\n"
                    "            with torch.device('meta'):\n"
                    "                model = model_cls(config)\n"
                    "        else:\n"
                    "            model = model_cls(config)"
                )
                if old_init in c and "with torch.device('meta')" not in c:
                    c = c.replace(old_init, new_init, 1)
                    dirty = True

                # 2. Load safetensors directly to GPU VRAM (FP16)
                if 'device="cpu"' in c:
                    c = c.replace('device="cpu"', 'device=("cuda" if torch.cuda.is_available() else "cpu")')
                    dirty = True

                # 3. Slow AR forward_generate self-healing causal_mask & freqs_cis
                old_fg = "mask = self.causal_mask["
                new_fg = (
                    "if self.causal_mask.is_meta or self.causal_mask.device != x.device:\n"
                    "            self.causal_mask = torch.tril(torch.ones(self.config.max_seq_len, self.config.max_seq_len, dtype=torch.bool, device=x.device))\n"
                    "        if self.freqs_cis.is_meta or self.freqs_cis.device != x.device:\n"
                    "            self.freqs_cis = precompute_freqs_cis(self.config.max_seq_len, self.config.head_dim, self.config.rope_base).to(x.device)\n"
                    "        mask = self.causal_mask["
                )
                if old_fg in c and "self.causal_mask.is_meta" not in c:
                    c = c.replace(old_fg, new_fg, 1)
                    dirty = True

                # 4. Fast AR forward_generate_fast self-healing fast_mask & fast_freqs_cis
                old_fgf = "fast_mask = self.causal_mask["
                new_fgf = (
                    "if self.causal_mask.is_meta or self.causal_mask.device != x.device:\n"
                    "            self.causal_mask = torch.tril(torch.ones(self.config.max_seq_len, self.config.max_seq_len, dtype=torch.bool, device=x.device))\n"
                    "        if self.fast_freqs_cis.is_meta or self.fast_freqs_cis.device != x.device:\n"
                    "            self.fast_freqs_cis = precompute_freqs_cis(self.config.num_codebooks, self.config.fast_head_dim, self.config.rope_base).to(x.device)\n"
                    "        fast_mask = self.causal_mask["
                )
                if old_fgf in c and "self.fast_freqs_cis.is_meta" not in c:
                    c = c.replace(old_fgf, new_fgf, 1)
                    dirty = True

                # 5. eq_scaled_dot_product_attention meta attn_mask guard
                old_eq = "if attn_mask is not None:\n            if attn_mask.dtype == torch.bool:"
                new_eq = (
                    "if attn_mask is not None:\n"
                    "            if attn_mask.is_meta:\n"
                    "                attn_mask = torch.tril(torch.ones(attn_mask.shape, dtype=attn_mask.dtype, device=query.device))\n"
                    "            elif attn_mask.device != query.device:\n"
                    "                attn_mask = attn_mask.to(query.device)\n"
                    "            if attn_mask.dtype == torch.bool:"
                )
                if old_eq in c and "attn_mask.is_meta" not in c:
                    c = c.replace(old_eq, new_eq, 1)
                    dirty = True

                # 6. apply_rotary_emb meta freqs_cis guard
                old_rope_sig = "def apply_rotary_emb(x: Tensor, freqs_cis: Tensor) -> Tensor:\n"
                rope_fix = (
                    "def apply_rotary_emb(x: Tensor, freqs_cis: Tensor) -> Tensor:\n"
                    "    if freqs_cis.is_meta:\n"
                    "        import torch as _t\n"
                    "        _sl, _hd, _ = freqs_cis.shape\n"
                    "        _theta = 1.0 / (1_000_000.0 ** (\n"
                    "            _t.arange(0, _hd * 2, 2, dtype=_t.float32, device=x.device) / (_hd * 2)))\n"
                    "        _freqs = _t.outer(_t.arange(_sl, dtype=_t.float32, device=x.device), _theta)\n"
                    "        freqs_cis = _t.stack([_freqs.cos(), _freqs.sin()], dim=-1).to(x.dtype)\n"
                )
                if old_rope_sig in c and "freqs_cis.is_meta" not in c:
                    c = c.replace(old_rope_sig, rope_fix, 1)
                    dirty = True

                if dirty:
                    with open(fpath, "w", encoding="utf-8") as f:
                        f.write(c)
                    print("    ⚡ Patched llama.py: Self-healing Zero-RAM GPU tensor engine active.")
            except Exception as e:
                print(f"    Notice (llama.py patch): {e}")

        if file == "inference.py":
            fpath = os.path.join(root, file)
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    c = f.read()
                target_to = "model = model.to(device=device, dtype=precision)"
                safe_to = "try:\n        model = model.to(device=device, dtype=precision)\n    except Exception:\n        pass"
                if target_to in c:
                    c = c.replace(target_to, safe_to)
                    with open(fpath, "w", encoding="utf-8") as f:
                        f.write(c)
                    print("    ⚡ Patched inference.py with safe device converter.")
            except Exception as e:
                pass

        if file == "vq_manager.py":
            fpath = os.path.join(root, file)
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    c = f.read()
                dirty = False
                old_load = "reference_audio_content = self.load_audio(reference_audio, sample_rate)"
                new_load = (
                    "reference_audio_content = self.load_audio(reference_audio, sample_rate)\n"
                    "            max_ref_samples = int(sample_rate * 6.5)\n"
                    "            if len(reference_audio_content) > max_ref_samples:\n"
                    "                reference_audio_content = reference_audio_content[:max_ref_samples]"
                )
                if old_load in c and "max_ref_samples" not in c:
                    c = c.replace(old_load, new_load)
                    dirty = True

                if "def decode_vq_tokens(" in c and "torch.cuda.empty_cache()" not in c:
                    c = re.sub(
                        r'def decode_vq_tokens\s*\(\s*self\s*,\s*tokens[^)]*\):',
                        'def decode_vq_tokens(self, tokens):\n        import torch\n        if torch.cuda.is_available():\n            torch.cuda.empty_cache()',
                        c,
                        count=1
                    )
                    dirty = True

                if dirty:
                    with open(fpath, "w", encoding="utf-8") as f:
                        f.write(c)
                    print("    ⚡ Patched vq_manager.py: Auto-trims reference audio + clears CUDA cache before DAC decode.")
            except Exception as e:
                pass

        if file == "tts.py" and "server" in root:
            fpath = os.path.join(root, file)
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    c = f.read()
                if "torch.cuda.empty_cache()" not in c:
                    c = re.sub(
                        r'return (Response|StreamingResponse|res|response)',
                        'import torch\n    if torch.cuda.is_available():\n        torch.cuda.empty_cache()\n    return \\1',
                        c,
                        count=1
                    )
                    with open(fpath, "w", encoding="utf-8") as f:
                        f.write(c)
                    print("    ⚡ Patched server/views/tts.py: Auto-cleans GPU VRAM after every generation.")
            except Exception:
                pass

print("    ✅ Fish Speech engine is configured.")

# ----------------- 2. CHECK GPU ACCELERATION ----------------- #
print("\n[2/4] Verifying GPU acceleration...")
try:
    import torch
    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0)
        vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        print(f"    ✅ GPU Active: {gpu_name} ({vram_gb:.2f} GB VRAM)")
    else:
        print("    ⚠️ No CUDA GPU detected! Switch to T4 GPU in Runtime -> Change runtime type.")
        gpu_name = "CPU"
except Exception as e:
    gpu_name = "CPU"

# ----------------- 3. VERIFY / DOWNLOAD S2 PRO NEURAL MODEL WEIGHTS (~11 GB) ----------------- #
print("\n[3/4] Verifying Fish Audio S2 Pro Neural Model weights (~11 GB)...")
TARGET_CKPT_DIR = os.path.abspath("fish-speech/checkpoints/s2-pro")
CODEC_PATH = os.path.join(TARGET_CKPT_DIR, "codec.pth")
os.makedirs(TARGET_CKPT_DIR, exist_ok=True)

found_ckpt = None
for candidate in [
    TARGET_CKPT_DIR,
    os.path.abspath("checkpoints/s2-pro"),
    "/content/checkpoints/s2-pro",
    "/content/fish-speech/checkpoints/s2-pro"
]:
    if os.path.exists(os.path.join(candidate, "codec.pth")) and (
        os.path.exists(os.path.join(candidate, "model.safetensors.index.json")) or
        os.path.exists(os.path.join(candidate, "model-00001-of-00002.safetensors"))
    ):
        found_ckpt = candidate
        break

if found_ckpt:
    print(f"    ✅ S2 Pro Neural weights verified: {found_ckpt}")
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
    print("    📥 Downloading Fish Audio S2 Pro weights from Hugging Face (~11 GB)...")
    print("       (Colab downloads at ~350 MB/s, takes ~25-35 seconds)...")
    from huggingface_hub import snapshot_download
    snapshot_download(
        repo_id="fishaudio/s2-pro",
        local_dir=TARGET_CKPT_DIR,
        max_workers=8
    )
    print("    ✅ Download complete! S2 Pro weights saved to", TARGET_CKPT_DIR)

# Optimize config.json max_seq_len for speech synthesis
# MUST be 4096 minimum: Fish Speech warm-up check is `tokens > max_seq_len - 2048`
# so max_seq_len=2048 → limit=0 → even 1 token fails. 4096 → limit=2048 (plenty for TTS).
# 4096 frees ~4.3 GB VRAM vs original 32768, still fits in 14.56 GB T4.
cfg_file = os.path.join(TARGET_CKPT_DIR, "config.json")
if os.path.exists(cfg_file):
    try:
        import json
        with open(cfg_file, "r", encoding="utf-8") as f:
            cdata = json.load(f)
        modified = False
        cur = cdata.get("max_seq_len", 0)
        if cur != 4096:
            cdata["max_seq_len"] = 4096
            modified = True
        if "text_config" in cdata and cdata["text_config"].get("max_seq_len", 0) != 4096:
            cdata["text_config"]["max_seq_len"] = 4096
            modified = True
        if modified:
            with open(cfg_file, "w", encoding="utf-8") as f:
                json.dump(cdata, f, indent=2)
            print(f"    ⚡ Set config.json max_seq_len: {cur} -> 4096 (frees ~4.3 GB VRAM, keeps warm-up working)")
        else:
            print("    ✅ config.json max_seq_len already set to 4096")
    except Exception as e:
        print(f"    Notice: {e}")

# ----------------- 4. ASSIGN PORT & LAUNCH NATIVE S2 PRO NEURAL SERVER ----------------- #
print("\n[4/4] Launching Real S2 Pro Neural GPU Engine & Cloudflare Tunnel...")

# Terminate any previous dangling server or tunnel processes to guarantee 100% free VRAM & clean port
subprocess.run(["pkill", "-9", "-f", "tools/api_server.py"], check=False)
subprocess.run(["pkill", "-9", "-f", "cloudflared"], check=False)
import gc
gc.collect()
try:
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
except Exception:
    pass
time.sleep(1.5)

# Set expandable segments to avoid memory fragmentation on Tesla T4
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

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
print(f"    [*] Local Port assigned: {PORT}")

cmd = [
    sys.executable, "tools/api_server.py",
    "--listen", f"127.0.0.1:{PORT}",
    "--llama-checkpoint-path", "checkpoints/s2-pro",
    "--decoder-checkpoint-path", "checkpoints/s2-pro/codec.pth",
    "--decoder-config-name", "modded_dac_vq",
]

if torch.cuda.is_available():
    cmd.extend(["--device", "cuda", "--half"])
else:
    cmd.extend(["--device", "cpu"])

print(f"    🚀 Loading S2 Pro (5B Dual-AR) into {gpu_name} VRAM (FP16)...")
print("    ⏳ Allocating GPU tensors (initial weight loading takes ~90-110s, please wait)...")

env = os.environ.copy()
env["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

proc = subprocess.Popen(
    cmd,
    cwd="fish-speech",
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1,
    env=env
)

server_ready_event = threading.Event()
last_activity_time = [time.time()]

def stream_logs(pipe):
    for line in iter(pipe.readline, ''):
        clean = line.strip()
        if clean:
            print("       " + clean, flush=True)
            if any(k in clean for k in ["POST /v1/tts", "POST /synthesize", "GET /v1/models", "POST /"]):
                last_activity_time[0] = time.time()
            if any(k in clean for k in ["Application startup complete", "Uvicorn running on", "Started server process"]):
                if "Application startup complete" in clean or "Uvicorn running on" in clean:
                    server_ready_event.set()

log_thread = threading.Thread(target=stream_logs, args=(proc.stdout,), daemon=True)
log_thread.start()

# Wait for server to finish loading the 11 GB weights and start Uvicorn (up to 4 minutes)
server_ready = False
MAX_WAIT_SECONDS = 240

for attempt in range(1, MAX_WAIT_SECONDS + 1):
    if proc.poll() is not None:
        print(f"\n[!] Neural server process exited unexpectedly with code {proc.returncode}!")
        break
        
    if server_ready_event.is_set():
        server_ready = True
        break

    # HTTP GET health check
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/health")
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            if resp.status == 200:
                server_ready = True
                break
    except urllib.error.HTTPError as e:
        if e.code in (200, 400, 404, 405, 422):
            server_ready = True
            break
    except Exception:
        pass

    if attempt % 15 == 0:
        print(f"       ⏳ Loading 5B Dual-AR weights into VRAM... ({attempt}s / {MAX_WAIT_SECONDS}s)")
    time.sleep(1)

if not server_ready:
    print("\n[!] Neural server did not start in time. Check the logs above.")
    while True:
        time.sleep(60)

# Server is verified active and responding on local port! Now spawn Cloudflare tunnel
print("    ✅ S2 Pro 5B Neural model loaded into GPU VRAM!")
print("    🌐 Spawning encrypted Cloudflare HTTPS secure tunnel...")

from pycloudflared import try_cloudflare
tunnel = try_cloudflare(port=PORT)
tunnel_url = getattr(tunnel, "tunnel", str(tunnel)).strip()

print("\n" + "=" * 76)
print("  🎉 FISH AUDIO S2 PRO (5B DUAL-AR) NEURAL GPU WORKER IS ONLINE & READY!")
print("=" * 76)
print(f"  ⚡ GPU Hardware:    {gpu_name}")
print(f"  ⚡ Neural Model:    fishaudio/s2-pro (5B Dual-AR, 11 GB Weights in VRAM)")
print(f"  ⚡ Emotion Engine:  Native [whisper], [scream], [sinister], [panic], etc.")
print(f"  🌐 TUNNEL URL:      {tunnel_url}")
print("=" * 76)
print("  📋 1-STEP CONNECTION:")
print("  1. Copy the TUNNEL URL above right now.")
print("  2. Open Studio (http://localhost:7865) -> Click 'Cloud GPU' in top bar.")
print("  3. Paste into Tunnel URL -> Click '⚡ Test Connection' -> 'Save & Activate'.")
print("=" * 76 + "\n")
print("[*] Worker is actively listening for voice synthesis requests. (Keep cell running!)\n")

# Inactivity Watchdog to prevent burning free GPU quota if user closes studio or walks away
INACTIVITY_TIMEOUT_SECONDS = 300  # 5 minutes of zero generation requests
last_activity_time[0] = time.time()

def inactivity_watchdog():
    while proc.poll() is None:
        time.sleep(30)
        idle_duration = time.time() - last_activity_time[0]
        if idle_duration > INACTIVITY_TIMEOUT_SECONDS:
            print("\n" + "=" * 76)
            print(f"  ⏱ INACTIVITY TIMEOUT DETECTED ({int(idle_duration / 60)} minutes idle)")
            print("  🛑 Terminating Kaggle GPU worker to protect user's free weekly GPU quota!")
            print("=" * 76 + "\n", flush=True)
            try:
                proc.terminate()
                time.sleep(2)
                proc.kill()
            except Exception:
                pass
            try:
                subprocess.run(["pkill", "-9", "-f", "cloudflared"], check=False)
            except Exception:
                pass
            os._exit(0)

watchdog_thread = threading.Thread(target=inactivity_watchdog, daemon=True)
watchdog_thread.start()

try:
    proc.wait()
except KeyboardInterrupt:
    proc.terminate()
    print("\n[!] Worker stopped by user.")
