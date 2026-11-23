"""
SQLite Database Layer for Fish Speech Studio.
Provides persistent, ACID-compliant relational storage for:
- Users (credentials, profiles, active subscriptions, word quotas)
- Sessions (secure auth tokens, timestamps, expiration)
- Usage Logs (auditable generation records)
"""

import sqlite3
import time
import json
import logging
from pathlib import Path
from typing import Dict, Optional, List, Any, Tuple

logger = logging.getLogger("StudioDB")

BASE_DIR = Path(__file__).resolve().parent.parent
PROJECTS_DIR = BASE_DIR / "projects"
DB_PATH = PROJECTS_DIR / "studio.db"
LEGACY_USERS_FILE = PROJECTS_DIR / "users.json"
LEGACY_SESSIONS_FILE = PROJECTS_DIR / "sessions.json"

DEFAULT_ADMIN_USER = {
    "user_id": "usr_local_admin",
    "email": "admin@localhost",
    "name": "Local Admin",
    "password_hash": "",
    "salt": "",
    "avatar_url": "",
    "auth_provider": "local",
    "active_tier": "author",
    "monthly_words_used": 0,
    "monthly_words_limit": 100000,
    "trial_renders_remaining": 5,
    "cycle_start_time": 0.0,
    "user_fish_api_key": "",
    "is_admin": 1,
    "created_at": 1700000000.0
}


class Database:
    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def _init_db(self):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            
            # Users table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    user_id TEXT PRIMARY KEY,
                    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
                    password_hash TEXT DEFAULT '',
                    salt TEXT DEFAULT '',
                    name TEXT DEFAULT '',
                    avatar_url TEXT DEFAULT '',
                    auth_provider TEXT DEFAULT 'email',
                    google_sub TEXT,
                    active_tier TEXT DEFAULT 'free',
                    monthly_words_used INTEGER DEFAULT 0,
                    monthly_words_limit INTEGER DEFAULT 0,
                    trial_renders_remaining INTEGER DEFAULT 5,
                    cycle_start_time REAL DEFAULT 0.0,
                    user_fish_api_key TEXT DEFAULT '',
                    is_admin INTEGER DEFAULT 0,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
            """)

            # Sessions table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    token TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    user_agent TEXT DEFAULT '',
                    ip_address TEXT DEFAULT ''
                );
            """)

            # Usage Audit Logs table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS usage_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    word_count INTEGER NOT NULL,
                    is_trial INTEGER DEFAULT 0,
                    engine TEXT DEFAULT 'drama-3',
                    created_at REAL NOT NULL
                );
            """)

            # Indexes for fast querying
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id);")

            # Check if default admin user exists
            cursor.execute("SELECT user_id FROM users WHERE user_id = 'usr_local_admin';")
            if not cursor.fetchone():
                now = time.time()
                cursor.execute("""
                    INSERT INTO users (
                        user_id, email, password_hash, salt, name, avatar_url,
                        auth_provider, active_tier, monthly_words_used, monthly_words_limit,
                        trial_renders_remaining, cycle_start_time, user_fish_api_key,
                        is_admin, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    "usr_local_admin", "admin@localhost", "", "", "Local Admin", "",
                    "local", "author", 0, 100000, 5, now, "", 1, 1700000000.0, now
                ))

            conn.commit()

        # Migrate existing users from legacy users.json if needed
        self._migrate_legacy_data()

    def _migrate_legacy_data(self):
        if not LEGACY_USERS_FILE.exists():
            return
        try:
            with open(LEGACY_USERS_FILE, "r", encoding="utf-8") as f:
                legacy_users = json.load(f)
            if not isinstance(legacy_users, dict):
                return

            with self.get_connection() as conn:
                cursor = conn.cursor()
                now = time.time()
                for uid, u in legacy_users.items():
                    if uid == "usr_local_admin":
                        continue
                    email = u.get("email", "").strip().lower()
                    if not email:
                        continue
                    cursor.execute("SELECT user_id FROM users WHERE email = ?;", (email,))
                    if cursor.fetchone():
                        continue  # Already exists

                    cursor.execute("""
                        INSERT INTO users (
                            user_id, email, password_hash, salt, name, avatar_url,
                            auth_provider, active_tier, monthly_words_used, monthly_words_limit,
                            trial_renders_remaining, cycle_start_time, user_fish_api_key,
                            is_admin, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        uid,
                        email,
                        u.get("password_hash", ""),
                        u.get("salt", ""),
                        u.get("name", ""),
                        u.get("avatar_url", ""),
                        u.get("auth_provider", "email"),
                        u.get("active_tier", "free"),
                        u.get("monthly_words_used", 0),
                        u.get("monthly_words_limit", 0),
                        u.get("trial_renders_remaining", 5),
                        u.get("cycle_start_time", now),
                        u.get("user_fish_api_key", ""),
                        1 if u.get("is_admin") else 0,
                        u.get("created_at", now),
                        now
                    ))
                conn.commit()
                logger.info(f"Successfully migrated {len(legacy_users)} legacy users to SQLite database.")
        except Exception as e:
            logger.warning(f"Legacy user migration warning: {e}")

    # ================= USER OPERATIONS ================= #

    def get_user_by_id(self, user_id: str) -> Optional[Dict]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE user_id = ?;", (user_id,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def get_user_by_email(self, email: str) -> Optional[Dict]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE email = ? COLLATE NOCASE;", (email.strip().lower(),))
            row = cursor.fetchone()
            return dict(row) if row else None

    def get_user_by_google_sub(self, google_sub: str) -> Optional[Dict]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE google_sub = ?;", (google_sub,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def create_user(
        self,
        user_id: str,
        email: str,
        password_hash: str = "",
        salt: str = "",
        name: str = "",
        avatar_url: str = "",
        auth_provider: str = "email",
        google_sub: Optional[str] = None,
        active_tier: str = "free",
        monthly_words_limit: int = 0
    ) -> Dict:
        now = time.time()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO users (
                    user_id, email, password_hash, salt, name, avatar_url,
                    auth_provider, google_sub, active_tier, monthly_words_used,
                    monthly_words_limit, trial_renders_remaining, cycle_start_time,
                    user_fish_api_key, is_admin, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                user_id, email.strip().lower(), password_hash, salt, name.strip(),
                avatar_url, auth_provider, google_sub, active_tier, 0,
                monthly_words_limit, 5, now, "", 0, now, now
            ))
            conn.commit()
        return self.get_user_by_id(user_id)

    def update_user(self, user_id: str, **kwargs) -> Optional[Dict]:
        if not kwargs:
            return self.get_user_by_id(user_id)
        
        kwargs["updated_at"] = time.time()
        set_clauses = [f"{k} = ?" for k in kwargs.keys()]
        values = list(kwargs.values()) + [user_id]

        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(f"UPDATE users SET {', '.join(set_clauses)} WHERE user_id = ?;", values)
            conn.commit()

        return self.get_user_by_id(user_id)

    def list_all_users(self) -> List[Dict]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users ORDER BY created_at DESC;")
            return [dict(r) for r in cursor.fetchall()]

    # ================= SESSION OPERATIONS ================= #

    def create_session(
        self,
        token: str,
        user_id: str,
        duration_days: int = 30,
        user_agent: str = "",
        ip_address: str = ""
    ) -> str:
        now = time.time()
        expires_at = now + (duration_days * 86400)
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent, ip_address)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (token, user_id, now, expires_at, user_agent, ip_address))
            conn.commit()
        return token

    def get_session_user(self, token: str) -> Optional[Dict]:
        if not token:
            return None
        now = time.time()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT u.* FROM sessions s
                JOIN users u ON s.user_id = u.user_id
                WHERE s.token = ? AND s.expires_at > ?;
            """, (token, now))
            row = cursor.fetchone()
            return dict(row) if row else None

    def delete_session(self, token: str):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM sessions WHERE token = ?;", (token,))
            conn.commit()

    def cleanup_expired_sessions(self):
        now = time.time()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM sessions WHERE expires_at <= ?;", (now,))
            conn.commit()

    # ================= USAGE AUDIT ================= #

    def log_usage(self, user_id: str, word_count: int, is_trial: bool = False, engine: str = "drama-3"):
        now = time.time()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO usage_logs (user_id, word_count, is_trial, engine, created_at)
                VALUES (?, ?, ?, ?, ?)
            """, (user_id, word_count, 1 if is_trial else 0, engine, now))
            conn.commit()


# Global Singleton Database Instance
db = Database()
