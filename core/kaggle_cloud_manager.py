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
        self._active_session: Dict[str, Any] = {
            "status": "idle",  # idle, launching, queued, booting, ready, error, stopped
            "username": "",
            "kernel_ref": "",
            "tunnel_url": "",
            "started_at": 0,
            "last_log": "",
            "error": ""
        }
        self._poll_thread: Optional[threading.Thread] = None
        self._stop_polling = threading.Event()

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

    def launch_worker(self, username: str, key: str) -> Dict[str, Any]:
        """
        Builds and pushes a private GPU worker kernel to the user's Kaggle account.
        Enables Tesla T4 GPU and Internet connectivity.
        """
        username = username.strip()
        key = key.strip()
        api = self._get_api(username, key)
        if not api:
            return {"ok": False, "error": "Could not authenticate with Kaggle API. Check your token."}

        if not self.worker_script_path.exists():
            return {"ok": False, "error": f"Worker script not found at {self.worker_script_path}"}

        kernel_slug = self.KERNEL_SLUG
        kernel_ref = f"{username}/{kernel_slug}"

        temp_dir = Path(tempfile.mkdtemp(prefix="kaggle_fish_"))
        try:
            metadata = {
                "id": kernel_ref,
                "title": "Fish Speech S2 Worker",
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
            shutil.copyfile(self.worker_script_path, worker_dst)

            print(f"[KaggleManager] Pushing GPU kernel {kernel_ref} to Kaggle...")
            resp = api.kernels_push(str(temp_dir))
            print(f"[KaggleManager] Push response: {resp}")

            self._active_session = {
                "status": "queued",
                "username": username,
                "kernel_ref": kernel_ref,
                "tunnel_url": "",
                "started_at": time.time(),
                "last_log": "Kernel pushed to Kaggle. Waiting for GPU container allocation...",
                "error": ""
            }

            self._start_polling(username, key, kernel_ref)

            return {
                "ok": True,
                "kernel_ref": kernel_ref,
                "status": "queued",
                "message": "Kernel successfully launched on Kaggle! Booting container..."
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
                    break

                if "cancel" in raw_status:
                    self._active_session["status"] = "stopped"
                    break

                # 2. Stream logs
                try:
                    for event in api.kernels_logs_stream(kernel_ref):
                        chunk = event.get("data", "")
                        if chunk:
                            self._active_session["last_log"] = (self._active_session["last_log"] + chunk)[-3000:]
                            tunnel_match = re.search(r'(https://[a-zA-Z0-9-]+\.trycloudflare\.com)', self._active_session["last_log"])
                            if tunnel_match:
                                tunnel_url = tunnel_match.group(1).rstrip('/') + '/'
                                print(f"[KaggleManager] 🎉 Auto-discovered Cloudflare Tunnel URL: {tunnel_url}")
                                self._active_session["tunnel_url"] = tunnel_url
                                self._active_session["status"] = "ready"
                                break
                except Exception as log_err:
                    pass

                # If tunnel found, we are ready!
                if self._active_session["tunnel_url"]:
                    self._active_session["status"] = "ready"
                    time.sleep(8)
                    continue

                if "running" in raw_status:
                    self._active_session["status"] = "booting"
                elif "queued" in raw_status:
                    self._active_session["status"] = "queued"

            except Exception as e:
                print(f"[KaggleManager] Poll notice: {e}")

            time.sleep(4)

    def get_status(self) -> Dict[str, Any]:
        """Returns the current live session status and progress."""
        elapsed = 0
        if self._active_session["started_at"] > 0:
            elapsed = int(time.time() - self._active_session["started_at"])

        return {
            "status": self._active_session["status"],
            "kernel_ref": self._active_session["kernel_ref"],
            "tunnel_url": self._active_session["tunnel_url"],
            "elapsed_seconds": elapsed,
            "last_log": self._active_session["last_log"],
            "error": self._active_session["error"]
        }

    def stop_worker(self, username: str, key: str) -> Dict[str, Any]:
        """Cancels and stops the running Kaggle GPU kernel to conserve quota."""
        self._stop_polling.set()
        api = self._get_api(username, key)
        kernel_ref = self._active_session.get("kernel_ref") or f"{username}/{self.KERNEL_SLUG}"

        if api:
            try:
                client = api.build_kaggle_client()
                client.kernels.kernels_api_client.cancel_kernel_session(kernel_ref)
                print(f"[KaggleManager] Successfully stopped Kaggle session {kernel_ref}")
            except Exception as e:
                print(f"[KaggleManager] Cancel session notice: {e}")

        self._active_session["status"] = "stopped"
        self._active_session["tunnel_url"] = ""
        return {"ok": True, "message": "Kaggle GPU session stopped."}
