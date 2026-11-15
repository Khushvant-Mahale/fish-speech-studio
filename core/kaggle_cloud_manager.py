import os
import re
import json
import time
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Dict, Optional, Tuple, Any

from core.dns_fallback import setup_resilient_dns

# Ensure resilient DNS is active
setup_resilient_dns()

try:
    from kaggle.api.kaggle_api_extended import KaggleApi
except ImportError:
    KaggleApi = None


class KaggleCloudManager:
    """
    Manages automated 1-Click Kaggle Cloud GPU sessions for Fish Speech Studio.
    Automates kernel creation, GPU allocation, log streaming, and tunnel auto-discovery.
    """

    KERNEL_SLUG = "fish-speech-s2-worker"

    def __init__(self, base_dir: Path):
        self.base_dir = base_dir
        self.worker_script_path = base_dir / "colab_fish_worker.py"
        self.session_file = base_dir / "projects" / "kaggle_session.json"
        self._active_session: Dict[str, Any] = {
            "status": "idle",  # idle, launching, queued, booting, ready, error, stopped
            "engine": "fish_s2",
            "username": "",
            "kernel_ref": "",
            "tunnel_url": "",
            "started_at": 0,
            "last_log": "",
            "error": ""
        }
        self._poll_thread: Optional[threading.Thread] = None
        self._stop_polling = threading.Event()
        self._load_session()

    def _save_session(self):
        try:
            self.session_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.session_file, "w", encoding="utf-8") as f:
                json.dump(self._active_session, f, indent=2)
        except Exception:
            pass

    def _load_session(self):
        if self.session_file.exists():
            try:
                with open(self.session_file, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                    if saved.get("tunnel_url"):
                        self._active_session.update(saved)
            except Exception:
                pass

    def _get_api(self, username: str, key: str) -> Optional[KaggleApi]:
        if not KaggleApi:
            return None
        os.environ["KAGGLE_USERNAME"] = username.strip()
        os.environ["KAGGLE_KEY"] = key.strip()
        try:
            api = KaggleApi()
            api.authenticate()
            return api
        except Exception as e:
            print(f"[KaggleManager] Auth error: {e}")
            return None

    def verify_credentials(self, username: str, key: str) -> Dict[str, Any]:
        """
        Validates the Kaggle Username & API Key against Kaggle's official API.
        Returns account validation and GPU quota status.
        """
        if not username or not key:
            return {"ok": False, "error": "Username and API Key are required."}

        if not KaggleApi:
            return {"ok": False, "error": "Kaggle Python SDK is not installed on this system."}

        try:
            api = self._get_api(username, key)
            if not api:
                return {
                    "ok": False,
                    "error": "Invalid or expired Kaggle credentials. Please generate a fresh token at kaggle.com/settings."
                }

            client = api.build_kaggle_client()
            quota_info = "30h / week"
            try:
                stats = client.kernels.kernels_api_client.get_accelerator_quota_statistics()
                if stats and hasattr(stats, "gpu"):
                    quota_info = f"{getattr(stats.gpu, 'remaining_hours', 30):.1f}h remaining"
            except Exception:
                pass

            return {
                "ok": True,
                "username": username.strip(),
                "quota": quota_info,
                "message": f"Successfully verified Kaggle account @{username.strip()}!"
            }
        except Exception as e:
            err_msg = str(e)
            if "401" in err_msg or "Unauthorized" in err_msg:
                return {
                    "ok": False,
                    "error": "Unauthorized (401): This API token is expired or revoked. Please create a new token in Kaggle Settings."
                }
            if "403" in err_msg or "Forbidden" in err_msg:
                return {
                    "ok": False,
                    "error": "Forbidden (403): Your Kaggle account requires phone verification to unlock free GPU and internet access."
                }
            return {"ok": False, "error": f"Kaggle API error: {err_msg}"}

    def launch_worker(self, username: str, key: str, engine: str = "fish_s2") -> Dict[str, Any]:
        """
        Builds and pushes a private GPU worker kernel to the user's Kaggle account.
        Enables Tesla T4 GPU and Internet connectivity.
        Supports both Kokoro engine and Fish Speech engine.
        """
        username = username.strip()
        key = key.strip()
        api = self._get_api(username, key)
        if not api:
            return {"ok": False, "error": "Could not authenticate with Kaggle API. Check your token."}

        is_kokoro = (engine == "kokoro")
        kernel_slug = "kokoro-tts-worker" if is_kokoro else "fish-speech-s2-worker"
        kernel_title = "Kokoro Story Studio Worker" if is_kokoro else "Fish Speech S2 Worker"
        worker_file = (self.base_dir / "colab_worker.py") if is_kokoro else (self.base_dir / "colab_fish_worker.py")

        if not worker_file.exists():
            return {"ok": False, "error": f"Worker script not found at {worker_file}"}

        kernel_ref = f"{username}/{kernel_slug}"

        temp_dir = Path(tempfile.mkdtemp(prefix=f"kaggle_{engine}_"))
        try:
            metadata = {
                "id": kernel_ref,
                "title": kernel_title,
                "code_file": "worker.py",
                "language": "python",
                "kernel_type": "script",
                "is_private": True,
                "enable_gpu": True,
                "enable_internet": True
            }

            meta_file = temp_dir / "kernel-metadata.json"
            meta_file.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

            worker_dst = temp_dir / "worker.py"
            shutil.copyfile(worker_file, worker_dst)

            print(f"[KaggleManager] Pushing GPU kernel {kernel_ref} ({engine}) to Kaggle...")
            resp = api.kernels_push(str(temp_dir))
            print(f"[KaggleManager] Push response: {resp}")

            self._active_session = {
                "status": "queued",
                "engine": engine,
                "username": username,
                "key": key,
                "kernel_ref": kernel_ref,
                "tunnel_url": "",
                "started_at": time.time(),
                "last_log": f"{kernel_title} pushed to Kaggle. Waiting for GPU container allocation...",
                "error": ""
            }
            self._save_session()

            self._start_polling(username, key, kernel_ref)

            return {
                "ok": True,
                "kernel_ref": kernel_ref,
                "engine": engine,
                "status": "queued",
                "message": f"{kernel_title} successfully launched on Kaggle! Booting container..."
            }
        except Exception as e:
            err_str = str(e)
            print(f"[KaggleManager] Launch error: {err_str}")
            return {"ok": False, "error": f"Failed to push Kaggle kernel: {err_str}"}
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def _start_polling(self, username: str, key: str, kernel_ref: str):
        self._stop_polling.set()
        if self._poll_thread and self._poll_thread.is_alive():
            self._poll_thread.join(timeout=2.0)

        self._stop_polling.clear()
        self._poll_thread = threading.Thread(
            target=self._poll_loop,
            args=(username, key, kernel_ref),
            daemon=True
        )
        self._poll_thread.start()

    def _poll_loop(self, username: str, key: str, kernel_ref: str):
        api = self._get_api(username, key)
        if not api:
            self._active_session["status"] = "error"
            self._active_session["error"] = "Authentication lost during polling."
            return

        print(f"[KaggleManager] Polling status and log stream for {kernel_ref}...")
        while not self._stop_polling.is_set():
            try:
                # 1. Check kernel execution status
                st_resp = api.kernels_status(kernel_ref)
                raw_status = str(getattr(st_resp, "status", "")).lower()
                fail_msg = str(getattr(st_resp, "failureMessage", "") or getattr(st_resp, "failure_message", "") or "")

                if "error" in raw_status:
                    self._active_session["status"] = "error"
                    self._active_session["error"] = fail_msg or "Kernel encountered an execution error."
                    self._active_session["tunnel_url"] = ""
                    self._save_session()
                    break

                if "cancel" in raw_status or "complete" in raw_status:
                    print(f"[KaggleManager] Kernel reached terminal status: {raw_status}. Session stopped.")
                    self._active_session["status"] = "stopped"
                    self._active_session["tunnel_url"] = ""
                    self._active_session["error"] = "Kaggle worker execution ended."
                    self._save_session()
                    break

                if "running" in raw_status:
                    if self._active_session["status"] == "queued":
                        self._active_session["status"] = "booting"
                elif "queued" in raw_status:
                    self._active_session["status"] = "queued"

                # 2. Stream logs
                try:
                    for event in api.kernels_logs_stream(kernel_ref):
                        chunk = event.get("data", "")
                        if chunk:
                            self._active_session["status"] = "booting"
                            self._active_session["last_log"] = (self._active_session["last_log"] + chunk)[-3000:]
                            tunnel_match = re.search(r'(https://[a-zA-Z0-9-]+\.trycloudflare\.com)', self._active_session["last_log"])
                            if tunnel_match:
                                tunnel_url = tunnel_match.group(1).rstrip('/') + '/'
                                print(f"[KaggleManager] 🎉 Auto-discovered Cloudflare Tunnel URL: {tunnel_url}")
                                self._active_session["tunnel_url"] = tunnel_url
                                self._active_session["status"] = "ready"
                                self._save_session()
                                break
                except Exception as log_err:
                    pass

                # 3. Fallback: inspect static logs if stream paused or closed
                if not self._active_session["tunnel_url"]:
                    try:
                        static_logs = api.kernels_logs(kernel_ref)
                        if static_logs:
                            self._active_session["last_log"] = static_logs[-3000:]
                            tunnel_match = re.search(r'(https://[a-zA-Z0-9-]+\.trycloudflare\.com)', static_logs)
                            if tunnel_match:
                                tunnel_url = tunnel_match.group(1).rstrip('/') + '/'
                                print(f"[KaggleManager] 🎉 Auto-discovered Cloudflare Tunnel URL (fallback logs): {tunnel_url}")
                                self._active_session["tunnel_url"] = tunnel_url
                                self._active_session["status"] = "ready"
                                self._save_session()
                    except Exception:
                        pass

                # If tunnel found, verify kernel is still running
                if self._active_session["tunnel_url"]:
                    if raw_status and "running" not in raw_status:
                        print(f"[KaggleManager] Kernel status changed to '{raw_status}'. Tunnel no longer active.")
                        self._active_session["status"] = "stopped"
                        self._active_session["tunnel_url"] = ""
                        self._save_session()
                        break
                    self._active_session["status"] = "ready"
                    self._save_session()
                    time.sleep(8)
                    continue

            except Exception as e:
                print(f"[KaggleManager] Poll notice: {e}")

            time.sleep(4)

    def get_status(self) -> Dict[str, Any]:
        """Returns the current live session status and progress."""
        if self._active_session["status"] in ("idle", "stopped"):
            self._load_session()
            if self._active_session.get("tunnel_url"):
                # Quick check if tunnel is alive
                import urllib.request
                try:
                    req = urllib.request.Request(
                        f"{self._active_session['tunnel_url'].rstrip('/')}/v1/health",
                        headers={"User-Agent": "FishSpeechStudio/1.0"}
                    )
                    with urllib.request.urlopen(req, timeout=2.0) as resp:
                        if resp.status == 200:
                            self._active_session["status"] = "ready"
                except Exception:
                    pass

        elapsed = 0
        if self._active_session["started_at"] > 0:
            elapsed = int(time.time() - self._active_session["started_at"])

        return {
            "status": self._active_session["status"],
            "engine": self._active_session.get("engine", "fish_s2"),
            "kernel_ref": self._active_session["kernel_ref"],
            "tunnel_url": self._active_session["tunnel_url"],
            "elapsed_seconds": elapsed,
            "last_log": self._active_session["last_log"],
            "error": self._active_session["error"]
        }

    def stop_worker(self, username: str = "", key: str = "", engine: str = "") -> Dict[str, Any]:
        """Cancels and stops the running Kaggle GPU kernel to conserve quota."""
        self._stop_polling.set()
        eng = engine or self._active_session.get("engine", "fish_s2")
        tunnel_url = (self._active_session.get("tunnel_url") or "").strip()
        username = (username or self._active_session.get("username", "")).strip()
        key = (key or self._active_session.get("key", "")).strip()

        # 1. Tier 1: Send remote killswitch to the worker via Cloudflare tunnel (instant, ~0.5s)
        if tunnel_url:
            for endpoint in ["/v1/shutdown", "/api/terminate"]:
                try:
                    import urllib.request
                    target = tunnel_url.rstrip("/") + endpoint
                    req = urllib.request.Request(
                        target,
                        data=b"{}",
                        headers={"Content-Type": "application/json", "User-Agent": "FishSpeechStudio/1.0"},
                        method="POST"
                    )
                    urllib.request.urlopen(req, timeout=2.0)
                    print(f"[KaggleManager] 🛑 Sent remote shutdown signal to {target}")
                    break
                except Exception as e:
                    print(f"[KaggleManager] Remote tunnel shutdown notice: {e}")

        # 2. Tier 2: Cancel/Terminate on Kaggle cloud side
        api = self._get_api(username, key) if (username and key) else None
        slug = "kokoro-tts-worker" if eng == "kokoro" else "fish-speech-s2-worker"
        kernel_ref = self._active_session.get("kernel_ref") or (f"{username}/{slug}" if username else "")

        if api and kernel_ref:
            try:
                print(f"[KaggleManager] Pushing zero-resource CPU stop script to cancel GPU container {kernel_ref}...")
                temp_dir = Path(tempfile.mkdtemp(prefix="kaggle_stop_"))
                try:
                    meta = {
                        "id": kernel_ref,
                        "title": "Fish Speech S2 Worker" if eng != "kokoro" else "Kokoro Story Studio Worker",
                        "code_file": "worker.py",
                        "language": "python",
                        "kernel_type": "script",
                        "is_private": True,
                        "enable_gpu": False,
                        "enable_internet": False
                    }
                    (temp_dir / "kernel-metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                    (temp_dir / "worker.py").write_text("# Session stopped by user\nimport os\nprint('Worker stopped.')\nos._exit(0)\n", encoding="utf-8")
                    resp = api.kernels_push(str(temp_dir))
                    print(f"[KaggleManager] Pushed stop kernel (version {getattr(resp, 'version_number', '?')}). Running GPU container cancelled!")
                finally:
                    shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception as e:
                print(f"[KaggleManager] Kaggle API stop notice: {e}")

        self._active_session["status"] = "stopped"
        self._active_session["tunnel_url"] = ""
        self._save_session()
        return {"ok": True, "message": "Kaggle GPU session stopped."}
