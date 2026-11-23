"""
TierManager: Central SaaS access control, quota accounting, and key resolution.
Supports multi-user sessions via AuthManager with fallback to local admin.
Supports:
  - "free"    -> Unlimited Fast Voices (Kokoro CPU) + 5 Drama 3 trial takes
  - "creator" -> 35,000 words/mo (~45 chapters) via platform Drama 3 API key ($14/mo)
  - "author"  -> 100,000 words/mo (~full novel) via platform Drama 3 API key ($29/mo)
  - "byok"    -> User's personal Fish Audio API key (unlimited)
  - "tunnel"  -> Custom GPU worker / Cloudflare tunnel (Kaggle/Colab/Local)
"""
import json
import time
from pathlib import Path
from typing import Dict, Optional, Tuple
from core.auth_manager import AuthManager

BASE_DIR = Path(__file__).resolve().parent.parent
TIER_FILE = BASE_DIR / "projects" / "tier.json"

DEFAULT_STATE = {
    "active_tier": "author",            # "free" | "creator" | "author" | "byok" | "tunnel"
    "trial_renders_remaining": 5,        # Free trial takes of Drama 3
    "monthly_words_used": 0,             # Words synthesized in current cycle
    "cycle_start_time": 0,               # Timestamp of billing cycle
    "creator_word_limit": 35000,         # 35K words for Creator ($14)
    "author_word_limit": 100000,         # 100K words for Author ($29)
    "user_fish_api_key": "",             # User-entered key for BYOK
    "platform_fish_api_key": "",         # Master server key for Creator/Author
}

class TierManager:
    def __init__(self):
        self.state = dict(DEFAULT_STATE)
        self.auth_mgr = AuthManager()
        self._load()

    def _load(self):
        if TIER_FILE.exists():
            try:
                with open(TIER_FILE, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                    self.state.update(saved)
            except Exception:
                pass

    def _save(self):
        TIER_FILE.parent.mkdir(parents=True, exist_ok=True)
        # Never write platform master key to disk in tier.json
        safe = {k: v for k, v in self.state.items() if k != "platform_fish_api_key"}
        with open(TIER_FILE, "w", encoding="utf-8") as f:
            json.dump(safe, f, indent=2)

    def get_tier(self, user: Optional[Dict] = None) -> str:
        if user:
            return user.get("active_tier", "free")
        return self.state.get("active_tier", "author")

    def set_tier(self, tier: str, byok_key: Optional[str] = None, user: Optional[Dict] = None):
        if tier in ("free", "creator", "author", "byok", "tunnel"):
            if user:
                self.auth_mgr.set_user_tier(user["user_id"], tier, byok_key=byok_key)
            else:
                self.state["active_tier"] = tier
                if byok_key is not None:
                    self.state["user_fish_api_key"] = byok_key.strip()
                self._save()

    def get_word_limit(self, user: Optional[Dict] = None) -> int:
        tier = self.get_tier(user)
        if tier == "creator":
            return self.state.get("creator_word_limit", 35000)
        if tier == "author":
            return self.state.get("author_word_limit", 100000)
        return 0

    def can_synthesize_fish(self, word_count: int, user: Optional[Dict] = None) -> Tuple[bool, str]:
        """
        Validates if Drama 3 synthesis is permitted under current tier.
        Returns: (allowed, reason_or_mode)
        """
        if user:
            return self.auth_mgr.can_user_synthesize_fish(user["user_id"], word_count)

        tier = self.get_tier()

        if tier == "tunnel":
            return True, "tunnel"

        if tier == "byok":
            if not self.state.get("user_fish_api_key"):
                return False, "No Fish Audio API key configured for BYOK mode. Enter your key in Settings."
            return True, "byok"

        if tier in ("creator", "author"):
            # Check 30-day billing cycle rollover
            cycle_start = self.state.get("cycle_start_time", 0)
            if cycle_start and (time.time() - cycle_start > 30 * 86400):
                self.state["monthly_words_used"] = 0
                self.state["cycle_start_time"] = time.time()
                self._save()
            elif not cycle_start:
                self.state["cycle_start_time"] = time.time()
                self._save()

            used = self.state.get("monthly_words_used", 0)
            limit = self.get_word_limit()
            if used + word_count > limit:
                return False, f"Monthly word quota exceeded ({used:,}/{limit:,} words). Switch to BYOK or upgrade plan."
            return True, "managed"

        # Free tier
        trials = self.state.get("trial_renders_remaining", 0)
        if trials > 0:
            return True, f"trial_{trials}"
        return False, "Free trial renders for Cinema Drama 3 exhausted. Switch to Fast Voices (free) or upgrade to Creator."

    def record_usage(self, word_count: int, is_trial: bool = False, user: Optional[Dict] = None):
        if user:
            self.auth_mgr.record_user_usage(user["user_id"], word_count, is_trial=is_trial)
            return

        tier = self.get_tier()
        if is_trial:
            trials = self.state.get("trial_renders_remaining", 0)
            if trials > 0:
                self.state["trial_renders_remaining"] = trials - 1
                self._save()
        elif tier in ("creator", "author"):
            self.state["monthly_words_used"] = self.state.get("monthly_words_used", 0) + word_count
            self._save()

    def resolve_api_key(self, user: Optional[Dict] = None) -> Optional[str]:
        tier = self.get_tier(user)
        if tier == "byok":
            if user:
                return user.get("user_fish_api_key") or None
            return self.state.get("user_fish_api_key") or None
        # Creator / Author / Free Trial use the server's platform master key
        return self.state.get("platform_fish_api_key") or None

    def get_public_status(self, user: Optional[Dict] = None) -> Dict:
        if user:
            pub = self.auth_mgr.get_public_user(user)
            pub["has_platform_key"] = bool(self.state.get("platform_fish_api_key"))
            return pub

        tier = self.get_tier()
        limit = self.get_word_limit()
        used = self.state.get("monthly_words_used", 0)
        remaining = max(0, limit - used) if limit > 0 else 0
        return {
            "active_tier": tier,
            "monthly_words_used": used,
            "monthly_words_limit": limit,
            "words_remaining": remaining,
            "trial_renders_remaining": self.state.get("trial_renders_remaining", 0),
            "has_byok_key": bool(self.state.get("user_fish_api_key")),
            "has_platform_key": bool(self.state.get("platform_fish_api_key"))
        }
