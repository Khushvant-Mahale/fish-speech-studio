import os
import sys
import time
import json
import socket
import logging
import threading
import subprocess
from pathlib import Path
from collections import deque
from typing import Dict, Any, Optional, Callable, List
import urllib.request
import urllib.error

logger = logging.getLogger("LocalGpuManager")


class LocalGpuManager:
    """
    Manages local hardware GPU detection, automated background worker lifecycle,
    and zero-terminal 1-click execution for Fish Speech Studio and Kokoro Studio.
    """

    def __init__(self, base_dir: Path):
        self.base_dir = base_dir
        self.fish_worker_script = base_dir / "colab_fish_worker.py"
        self.kokoro_worker_script = base_dir / "colab_worker.py"
        self.session_file = base_dir / "projects" / "local_gpu_session.json"

        self.status = "offline"  # offline, booting, ready, error
        self.engine = "fish_s2"
        self.port = 8080
        self.url = ""
        self.error = ""
        self.logs: deque = deque(maxlen=250)

        self._proc: Optional[subprocess.Popen] = None
        self._log_thread: Optional[threading.Thread] = None
        self._monitor_thread: Optional[threading.Thread] = None
        self._on_ready_callback: Optional[Callable[[str], None]] = None

        self._cached_hardware: Optional[Dict[str, Any]] = None
        self._last_hw_check = 0.0

    def detect_hardware(self, force_refresh: bool = False) -> Dict[str, Any]:
        """
        Detects GPU hardware and VRAM availability.
        Checks:
          1. PyTorch CUDA (device 0 name & total VRAM)
          2. nvidia-smi CLI (fallback if torch is CPU-only in current virtualenv)
          3. Windows CIM/WMI fallback for non-NVIDIA or integrated display adapters
        Evaluates capability specifically for Fish Audio S2 Pro (11GB+ VRAM required)
        and Kokoro (~1.5GB VRAM).
        """
        now = time.time()
        if not force_refresh and self._cached_hardware and (now - self._last_hw_check < 30):
            return self._cached_hardware

        info: Dict[str, Any] = {
            "has_gpu": False,
            "is_nvidia": False,
            "cuda_available": False,
            "gpu_name": "None",
            "vram_gb": 0.0,
            "is_capable": False,
            "can_run_kokoro": False,
            "status": "incompatible",  # capable, low_vram, incompatible
            "message": "",
            "min_required_gb": 11.0,
        }

        # 1. PyTorch CUDA check
        try:
            import torch
            if torch.cuda.is_available():
                info["has_gpu"] = True
                info["is_nvidia"] = True
                info["cuda_available"] = True
                info["gpu_name"] = torch.cuda.get_device_name(0)
                mem = torch.cuda.get_device_properties(0).total_memory
                info["vram_gb"] = round(mem / (1024**3), 1)
        except Exception:
            pass

        # 2. nvidia-smi fallback (in case torch was installed as CPU-only in this venv)
        if not info["is_nvidia"]:
            try:
                res = subprocess.run(
                    ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                    capture_output=True, text=True, timeout=3
                )
                if res.returncode == 0 and res.stdout.strip():
                    line = res.stdout.strip().splitlines()[0]
                    parts = line.split(",")
                    if len(parts) >= 2:
                        info["has_gpu"] = True
                        info["is_nvidia"] = True
                        info["gpu_name"] = parts[0].strip()
                        info["vram_gb"] = round(float(parts[1].strip()) / 1024.0, 1)
            except Exception:
                pass

        # 3. Windows CIM/WMI fallback for non-NVIDIA / Integrated
        if not info["has_gpu"]:
            try:
                cmd = "Get-CimInstance Win32_VideoController | Select-Object -First 1 Name, AdapterRAM | ConvertTo-Json"
                res = subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True, text=True, timeout=5)
                if res.returncode == 0 and res.stdout.strip():
                    data = json.loads(res.stdout.strip())
                    name = data.get("Name", "Unknown Display Adapter")
                    ram = data.get("AdapterRAM", 0) or 0
                    info["has_gpu"] = True
                    info["gpu_name"] = name
                    info["vram_gb"] = round(float(ram) / (1024**3), 1)
                    info["is_nvidia"] = "nvidia" in name.lower()
            except Exception:
                pass

        # Capability classification for Fish Audio S2 Pro
        info["can_run_kokoro"] = bool(info["is_nvidia"] or info["vram_gb"] >= 1.5)
        if info["is_nvidia"]:
            if info["vram_gb"] >= 11.0:
                info["is_capable"] = True
                info["status"] = "capable"
                info["message"] = f"Capable ({info['vram_gb']} GB VRAM). Local GPU can run Fish S2 Pro locally with 0 latency."
            else:
                info["is_capable"] = False
                info["status"] = "low_vram"
                info["message"] = f"Low VRAM ({info['vram_gb']} GB). Fish S2 Pro requires >= 12 GB VRAM. Recommended: Use Cloud API or 1-Click Kaggle GPU."
        else:
            info["is_capable"] = False
            info["status"] = "incompatible"
            info["message"] = f"No dedicated NVIDIA CUDA GPU detected ({info['gpu_name']}, {info['vram_gb']} GB). Fish S2 Pro requires an NVIDIA GPU with 12GB+ VRAM. Recommended: Use Cloud API or 1-Click Kaggle GPU."

        self._cached_hardware = info
        self._last_hw_check = now
        return info

    def is_port_in_use(self, port: int) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            return s.connect_ex(("127.0.0.1", port)) == 0

    def check_health(self, port: int) -> bool:
        """Pings local worker health endpoint."""
        for path in ("/v1/health", "/health", "/v1/tts/defaults"):
            try:
                req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers={"User-Agent": "Studio/1.0"})
                with urllib.request.urlopen(req, timeout=1.0) as resp:
                    if resp.status in (200, 404):
                        return True
            except urllib.error.HTTPError as e:
                if e.code in (200, 400, 404, 405, 422):
                    return True
            except Exception:
                pass
        return False

    def start_worker(
        self,
        engine: str = "fish_s2",
        port: int = 8080,
        callback: Optional[Callable[[str], None]] = None
    ) -> Dict[str, Any]:
        """
        Starts local worker in background subprocess without requiring terminal input.
        """
        if callback:
            self._on_ready_callback = callback

        # Check if already running on this port
        if self.check_health(port):
            self.status = "ready"
            self.port = port
            self.url = f"http://127.0.0.1:{port}"
            self.error = ""
            if self._on_ready_callback:
                try:
                    self._on_ready_callback(self.url)
                except Exception:
                    pass
            return {"ok": True, "status": "ready", "url": self.url, "already_running": True}

        if self._proc and self._proc.poll() is None:
            return {"ok": True, "status": self.status, "url": self.url, "message": "Worker is already booting or running"}

        script = self.fish_worker_script if engine == "fish_s2" else self.kokoro_worker_script
        if not script.exists():
            return {"ok": False, "error": f"Worker script not found: {script}"}

        self.status = "booting"
        self.port = port
        self.engine = engine
        self.url = f"http://127.0.0.1:{port}"
        self.error = ""
        self.logs.clear()
        self.logs.append(f"[*] Launching Local GPU Worker ({engine}) on 127.0.0.1:{port}...")

        cmd = [sys.executable, "-u", str(script), "--port", str(port), "--local"]
        try:
            env = os.environ.copy()
            env["PYTHONUNBUFFERED"] = "1"
            self._proc = subprocess.Popen(
                cmd,
                cwd=str(self.base_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env=env
            )
        except Exception as e:
            self.status = "error"
            self.error = f"Failed to spawn worker process: {e}"
            return {"ok": False, "error": self.error}

        # Background thread to stream logs
        def _read_output(pipe):
            try:
                for line in iter(pipe.readline, ''):
                    clean = line.strip()
                    if clean:
                        self.logs.append(clean)
            except Exception:
                pass

        self._log_thread = threading.Thread(target=_read_output, args=(self._proc.stdout,), daemon=True)
        self._log_thread.start()

        # Background thread to monitor health until server is responding
        def _monitor():
            max_wait = 180  # 3 minutes for weights to load
            for _ in range(max_wait):
                if self._proc is None or self._proc.poll() is not None:
                    code = self._proc.returncode if self._proc else -1
                    self.status = "error"
                    self.error = f"Local worker process exited unexpectedly (code {code}). Check logs."
                    return

                if self.check_health(self.port):
                    self.status = "ready"
                    self.error = ""
                    self.logs.append(f"✅ Local GPU Worker is ONLINE and responding at {self.url}!")
                    if self._on_ready_callback:
                        try:
                            self._on_ready_callback(self.url)
                        except Exception:
                            pass
                    return
                time.sleep(1)

            if self.status != "ready":
                self.status = "error"
                self.error = "Local worker startup timed out after 180 seconds. Check logs."

        self._monitor_thread = threading.Thread(target=_monitor, daemon=True)
        self._monitor_thread.start()

        return {"ok": True, "status": "booting", "port": port, "url": self.url}

    def stop_worker(self) -> Dict[str, Any]:
        """Terminates local GPU worker cleanly."""
        if self._proc:
            try:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self._proc.kill()
            except Exception as e:
                logger.warning(f"Error terminating worker: {e}")
            self._proc = None

        self.status = "offline"
        self.url = ""
        self.logs.append("🛑 Local GPU Worker stopped by user.")
        return {"ok": True, "status": "offline"}

    def get_status(self) -> Dict[str, Any]:
        # If in ready state, verify it's still alive
        if self.status == "ready" and not self.check_health(self.port):
            if self._proc and self._proc.poll() is not None:
                self.status = "offline"
                self.url = ""

        return {
            "status": self.status,
            "engine": self.engine,
            "port": self.port,
            "url": self.url if self.status == "ready" else "",
            "error": self.error,
            "logs": list(self.logs)[-30:],
            "hardware": self.detect_hardware(),
        }

    def auto_start_if_enabled(self, cfg: dict, on_ready: Optional[Callable[[str], None]] = None):
        """
        Called on studio boot: if user has enabled auto_launch_local_gpu AND hardware is capable,
        spawns worker automatically in background!
        """
        auto_enabled = cfg.get("auto_launch_local_gpu", False)
        if not auto_enabled:
            return

        hw = self.detect_hardware()
        if hw.get("is_capable"):
            print(f"[LocalGpuManager] ⚡ Capable NVIDIA GPU detected ({hw['gpu_name']}, {hw['vram_gb']} GB VRAM). Auto-starting local GPU worker...")
            self.start_worker(engine="fish_s2", port=8080, callback=on_ready)
        else:
            print(f"[LocalGpuManager] Auto-launch skipped: Hardware not capable for local S2 Pro ({hw['gpu_name']}, {hw['vram_gb']} GB VRAM).")
