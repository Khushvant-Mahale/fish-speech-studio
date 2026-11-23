"""
AuthManager: Secure user authentication, session management, and per-user quota tracking
backed by SQLite (core/database.py).

Features:
- Real SQLite database (projects/studio.db) with ACID transactions.
- Password hashing with PBKDF2-HMAC-SHA256 (100,000 iterations).
- Real session expiration and validation.
- Per-user plan/quota isolation (tier, words used, trial renders).
- Real Google Identity Services (GSI) OAuth support.
"""

import os
import time
import uuid
import hashlib
from typing import Dict, Optional, Tuple, List
from core.database import db, DEFAULT_ADMIN_USER


class AuthManager:
    def __init__(self):
        self.db = db

    @staticmethod
    def _hash_password(password: str, salt: Optional[str] = None) -> Tuple[str, str]:
        if salt is None:
            salt = os.urandom(16).hex()
        pwd_bytes = password.encode("utf-8")
        salt_bytes = bytes.fromhex(salt)
        h = hashlib.pbkdf2_hmac("sha256", pwd_bytes, salt_bytes, 100000).hex()
        return h, salt

    def register(self, email: str, password: str, name: str = "") -> Tuple[bool, str, Optional[Dict]]:
        """
        Registers a new user in SQLite.
        Returns: (success, message_or_token, user_dict)
        """
        email = email.strip().lower()
        if not email or "@" not in email:
            return False, "Invalid email address.", None

        if len(password) < 6:
            return False, "Password must be at least 6 characters.", None

        existing = self.db.get_user_by_email(email)
        if existing:
            return False, "An account with this email already exists.", None

        pwd_hash, salt = self._hash_password(password)
        user_id = f"usr_{uuid.uuid4().hex[:12]}"
        user_name = name.strip() or email.split("@")[0].capitalize()

        user = self.db.create_user(
            user_id=user_id,
            email=email,
            password_hash=pwd_hash,
            salt=salt,
            name=user_name,
            auth_provider="email",
            active_tier="free",
            monthly_words_limit=0
        )

        token = uuid.uuid4().hex
        self.db.create_session(token=token, user_id=user_id)
        return True, token, self.get_public_user(user)

    def login(self, email: str, password: str) -> Tuple[bool, str, Optional[Dict]]:
        """
        Authenticates a user against SQLite credentials.
        Returns: (success, message_or_token, user_dict)
        """
        email = email.strip().lower()
        if not email or not password:
            return False, "Email and password are required.", None

        user = self.db.get_user_by_email(email)
        if not user:
            return False, "Invalid email or password.", None

        # Check password hash
        stored_hash = user.get("password_hash")
        salt = user.get("salt")
        if not stored_hash or not salt:
            if user.get("auth_provider") == "google":
                return False, "This account was created with Google Sign-In. Please sign in with Google.", None
            return False, "Account has no password set.", None

        computed_hash, _ = self._hash_password(password, salt)
        if computed_hash != stored_hash:
            return False, "Invalid email or password.", None

        token = uuid.uuid4().hex
        self.db.create_session(token=token, user_id=user["user_id"])
        return True, token, self.get_public_user(user)

    def login_or_register_google(
        self,
        email: str,
        name: str = "",
        google_sub: Optional[str] = None,
        avatar: str = ""
    ) -> Tuple[bool, str, Optional[Dict]]:
        """
        Authenticates or auto-registers a user from Google Identity Services (GSI).
        """
        email = email.strip().lower()
        if not email or "@" not in email:
            return False, "Invalid Google email address.", None

        user = None
        if google_sub:
            user = self.db.get_user_by_google_sub(google_sub)
        if not user:
            user = self.db.get_user_by_email(email)

        if not user:
            user_id = f"usr_{uuid.uuid4().hex[:12]}"
            user_name = name.strip() or email.split("@")[0].capitalize()
            user = self.db.create_user(
                user_id=user_id,
                email=email,
                name=user_name,
                avatar_url=avatar,
                auth_provider="google",
                google_sub=google_sub,
                active_tier="free",
                monthly_words_limit=0
            )
        else:
            updates = {}
            if avatar and not user.get("avatar_url"):
                updates["avatar_url"] = avatar
            if name and not user.get("name"):
                updates["name"] = name
            if google_sub and not user.get("google_sub"):
                updates["google_sub"] = google_sub
            if updates:
                user = self.db.update_user(user["user_id"], **updates)

        token = uuid.uuid4().hex
        self.db.create_session(token=token, user_id=user["user_id"])
        return True, token, self.get_public_user(user)

    def logout(self, token: str):
        if token:
            self.db.delete_session(token)

    def get_user_by_session(self, token: Optional[str]) -> Optional[Dict]:
        """
        Retrieves user from active SQLite session token.
        Returns None if token is invalid or expired.
        """
        if not token:
            return None
        return self.db.get_session_user(token)

    def get_user_by_id(self, user_id: str) -> Optional[Dict]:
        return self.db.get_user_by_id(user_id)

    def get_public_user(self, user: Optional[Dict]) -> Optional[Dict]:
        """
        Returns safe user profile without password or salt.
        """
        if not user:
            return None
        tier = user.get("active_tier", "free")
        limit = self.get_tier_word_limit(tier)
        used = user.get("monthly_words_used", 0)
        remaining = max(0, limit - used) if limit > 0 else 0

        return {
            "user_id": user.get("user_id"),
            "email": user.get("email"),
            "name": user.get("name"),
            "avatar_url": user.get("avatar_url", ""),
            "auth_provider": user.get("auth_provider", "email"),
            "is_admin": bool(user.get("is_admin")),
            "active_tier": tier,
            "monthly_words_used": used,
            "monthly_words_limit": limit,
            "words_remaining": remaining,
            "trial_renders_remaining": user.get("trial_renders_remaining", 0),
            "has_byok_key": bool(user.get("user_fish_api_key")),
            "created_at": user.get("created_at")
        }

    @staticmethod
    def get_tier_word_limit(tier: str) -> int:
        if tier == "creator":
            return 35000
        if tier == "author":
            return 100000
        return 0

    def set_user_tier(self, user_id: str, tier: str, byok_key: Optional[str] = None) -> Optional[Dict]:
        user = self.get_user_by_id(user_id)
        if not user:
            return None

        if tier in ("free", "creator", "author", "byok", "tunnel"):
            updates = {
                "active_tier": tier,
                "monthly_words_limit": self.get_tier_word_limit(tier)
            }
            if byok_key is not None:
                updates["user_fish_api_key"] = byok_key.strip()
            user = self.db.update_user(user_id, **updates)
            return self.get_public_user(user)
        return None

    def can_user_synthesize_fish(self, user_id: str, word_count: int) -> Tuple[bool, str]:
        user = self.get_user_by_id(user_id)
        if not user:
            return False, "User not found."

        tier = user.get("active_tier", "free")

        if tier == "tunnel":
            return True, "tunnel"

        if tier == "byok":
            if not user.get("user_fish_api_key"):
                return False, "No Fish Audio API key configured for BYOK mode. Enter your key in Settings."
            return True, "byok"

        if tier in ("creator", "author"):
            cycle_start = user.get("cycle_start_time", 0.0)
            now = time.time()
            if cycle_start and (now - cycle_start > 30 * 86400):
                self.db.update_user(user_id, monthly_words_used=0, cycle_start_time=now)
                user = self.get_user_by_id(user_id)
            elif not cycle_start:
                self.db.update_user(user_id, cycle_start_time=now)
                user = self.get_user_by_id(user_id)

            used = user.get("monthly_words_used", 0)
            limit = self.get_tier_word_limit(tier)
            if used + word_count > limit:
                return False, f"Monthly word quota exceeded ({used:,}/{limit:,} words). Switch to BYOK or upgrade plan."
            return True, "managed"

        # Free tier
        trials = user.get("trial_renders_remaining", 0)
        if trials > 0:
            return True, f"trial_{trials}"
        return False, "Free trial renders for Cinema Drama 3 exhausted. Switch to Fast Voices (free) or upgrade to Creator."

    def record_user_usage(self, user_id: str, word_count: int, is_trial: bool = False):
        user = self.get_user_by_id(user_id)
        if not user:
            return

        tier = user.get("active_tier", "free")
        if tier in ("creator", "author"):
            new_used = user.get("monthly_words_used", 0) + word_count
            self.db.update_user(user_id, monthly_words_used=new_used)
        elif tier == "free" and is_trial:
            remaining = max(0, user.get("trial_renders_remaining", 5) - 1)
            self.db.update_user(user_id, trial_renders_remaining=remaining)

        self.db.log_usage(user_id=user_id, word_count=word_count, is_trial=is_trial, engine="drama-3")
