"""
Database Layer for Fish Speech Studio.
Provides persistent, ACID-compliant relational storage for:
- Users (credentials, profiles, active subscriptions, word quotas)
- Sessions (secure auth tokens, timestamps, expiration)
- Usage Logs (auditable generation records)
- Projects (complete project states, sentences, blocks, and voice directing metadata)

Supports:
- PostgreSQL (via DATABASE_URL / POSTGRES_URL - e.g., Render Managed Postgres)
- SQLite (local studio.db fallback when no external database is configured)
"""

import os
import sqlite3
import time
import json
import logging
from pathlib import Path
from typing import Dict, Optional, List, Any

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

try:
    import psycopg2
    import psycopg2.extras
    PSYCOPG2_AVAILABLE = True
except ImportError:
    PSYCOPG2_AVAILABLE = False


class UnifiedCursor:
    def __init__(self, cursor, is_postgres: bool):
        self._cursor = cursor
        self.is_postgres = is_postgres

    def execute(self, query: str, params: Any = None):
        if self.is_postgres:
            query = query.replace("?", "%s")
        if params is None:
            return self._cursor.execute(query)
        return self._cursor.execute(query, params)

    def executemany(self, query: str, seq_of_params: Any):
        if self.is_postgres:
            query = query.replace("?", "%s")
        return self._cursor.executemany(query, seq_of_params)

    def fetchone(self) -> Optional[Dict]:
        row = self._cursor.fetchone()
        return dict(row) if row else None

    def fetchall(self) -> List[Dict]:
        rows = self._cursor.fetchall()
        return [dict(r) for r in rows] if rows else []

    @property
    def rowcount(self) -> int:
        return self._cursor.rowcount

    def __getattr__(self, name):
        return getattr(self._cursor, name)


class UnifiedConnection:
    def __init__(self, conn, is_postgres: bool):
        self._conn = conn
        self.is_postgres = is_postgres

    def cursor(self):
        if self.is_postgres:
            return UnifiedCursor(self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor), is_postgres=True)
        else:
            return UnifiedCursor(self._conn.cursor(), is_postgres=False)

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is not None:
            self.rollback()
        else:
            self.commit()
        if self.is_postgres:
            try:
                self.close()
            except Exception:
                pass


class Database:
    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.database_url = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
        self.is_postgres = False

        if self.database_url and PSYCOPG2_AVAILABLE:
            if self.database_url.startswith("postgres://"):
                self.database_url = "postgresql://" + self.database_url[11:]
            try:
                test_conn = psycopg2.connect(self.database_url)
                test_conn.close()
                self.is_postgres = True
                logger.info("Connected to PostgreSQL database for persistent storage.")
            except Exception as e:
                logger.warning(f"Failed to connect to PostgreSQL via DATABASE_URL ({e}). Falling back to SQLite.")
                self.is_postgres = False
        elif self.database_url and not PSYCOPG2_AVAILABLE:
            logger.warning("DATABASE_URL is set but psycopg2 is not installed. Falling back to SQLite.")

        self._init_db()

    def get_connection(self) -> UnifiedConnection:
        if self.is_postgres:
            conn = psycopg2.connect(self.database_url)
            return UnifiedConnection(conn, is_postgres=True)
        else:
            conn = sqlite3.connect(str(self.db_path), timeout=30.0)
            conn.row_factory = sqlite3.Row
            try:
                conn.execute("PRAGMA journal_mode=WAL;")
                conn.execute("PRAGMA foreign_keys=ON;")
            except Exception:
                pass
            return UnifiedConnection(conn, is_postgres=False)

    def _init_db(self):
        with self.get_connection() as conn:
            cursor = conn.cursor()

            # Users table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    user_id TEXT PRIMARY KEY,
                    email TEXT UNIQUE NOT NULL,
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
            if self.is_postgres:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS usage_logs (
                        id SERIAL PRIMARY KEY,
                        user_id TEXT NOT NULL,
                        word_count INTEGER NOT NULL,
                        is_trial INTEGER DEFAULT 0,
                        engine TEXT DEFAULT 'drama-3',
                        created_at REAL NOT NULL
                    );
                """)
            else:
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

            # Projects table for permanent storage across container rebuilds & redeployments
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    title TEXT DEFAULT '',
                    owner_id TEXT DEFAULT '',
                    engine TEXT DEFAULT 'fish_s2',
                    data TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
            """)

            # Indexes for fast querying
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id);")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);")

            # Check if default admin user exists
            cursor.execute("SELECT user_id FROM users WHERE user_id = ?;", ("usr_local_admin",))
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

        # Seed existing project JSON files from disk into DB
        self._sync_disk_projects_to_db()

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
                    cursor.execute("SELECT user_id FROM users WHERE LOWER(email) = LOWER(?);", (email,))
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
                logger.info(f"Successfully migrated legacy users to database.")
        except Exception as e:
            logger.warning(f"Legacy user migration warning: {e}")

    def _sync_disk_projects_to_db(self):
        """Seed project JSON files from disk into DB so showcase & existing projects are guaranteed in DB."""
        if not PROJECTS_DIR.exists():
            return
        try:
            disk_files = list(PROJECTS_DIR.glob("*.json"))
            seeded = 0
            for p in disk_files:
                if p.name in ("config.json", "users.json", "sessions.json", "tier.json", "kaggle_session.json"):
                    continue
                try:
                    with open(p, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    if isinstance(data, dict) and data.get("id"):
                        proj_id = data["id"]
                        title = data.get("title", "")
                        owner_id = data.get("owner_id", "")
                        engine = data.get("engine", "fish_s2")
                        # Check if project already in DB
                        existing = self.get_project(proj_id)
                        if not existing:
                            self.save_project(proj_id, data)
                            seeded += 1
                except Exception:
                    continue
            if seeded > 0:
                logger.info(f"Seeded {seeded} disk projects into database.")
        except Exception as e:
            logger.warning(f"Sync disk projects to DB warning: {e}")

    # ================= USER OPERATIONS ================= #

    def get_user_by_id(self, user_id: str) -> Optional[Dict]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE user_id = ?;", (user_id,))
            return cursor.fetchone()

    def get_user_by_email(self, email: str) -> Optional[Dict]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE LOWER(email) = LOWER(?);", (email.strip(),))
            return cursor.fetchone()

    def get_user_by_google_sub(self, google_sub: str) -> Optional[Dict]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE google_sub = ?;", (google_sub,))
            return cursor.fetchone()

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
    ) -> Optional[Dict]:
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
            return cursor.fetchall()

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
            return cursor.fetchone()

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

    # ================= PROJECT OPERATIONS ================= #

    def save_project(self, project_id: str, project_data: Dict) -> bool:
        """Persist full project data to relational DB, surviving container rebuilds."""
        if not project_id:
            return False
        title = project_data.get("title", "Untitled Project") or "Untitled Project"
        owner_id = project_data.get("owner_id", "")
        engine = project_data.get("engine", "fish_s2")
        data_json = json.dumps(project_data, ensure_ascii=False)
        now = time.time()

        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO projects (id, title, owner_id, engine, data, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    owner_id = CASE WHEN excluded.owner_id != '' THEN excluded.owner_id ELSE projects.owner_id END,
                    engine = excluded.engine,
                    data = excluded.data,
                    updated_at = excluded.updated_at;
            """, (project_id, title, owner_id, engine, data_json, now, now))
            conn.commit()
        return True

    def get_project(self, project_id: str) -> Optional[Dict]:
        """Fetch project data from DB."""
        if not project_id:
            return None
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT data FROM projects WHERE id = ?;", (project_id,))
            row = cursor.fetchone()
            if row and row.get("data"):
                try:
                    return json.loads(row["data"])
                except Exception as e:
                    logger.error(f"Error parsing project JSON for {project_id}: {e}")
            return None

    def list_projects(self, owner_id: Optional[str] = None) -> List[Dict]:
        """Return all project records from DB."""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            if owner_id:
                cursor.execute(
                    "SELECT id, title, owner_id, engine, data, created_at, updated_at FROM projects WHERE owner_id = ? ORDER BY updated_at DESC;",
                    (owner_id,)
                )
            else:
                cursor.execute(
                    "SELECT id, title, owner_id, engine, data, created_at, updated_at FROM projects ORDER BY updated_at DESC;"
                )
            rows = cursor.fetchall()
            results = []
            for r in rows:
                p_data = None
                if r.get("data"):
                    try:
                        p_data = json.loads(r["data"])
                    except Exception:
                        pass
                if not p_data:
                    p_data = {
                        "id": r["id"],
                        "title": r.get("title") or "Untitled Project",
                        "engine": r.get("engine", "fish_s2"),
                        "owner_id": r.get("owner_id", "")
                    }
                results.append(p_data)
            return results

    def delete_project(self, project_id: str) -> bool:
        """Delete project from DB."""
        if not project_id:
            return False
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM projects WHERE id = ?;", (project_id,))
            conn.commit()
            return cursor.rowcount > 0


# Global Singleton Database Instance
db = Database()
