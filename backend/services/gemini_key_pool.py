"""
gemini_key_pool.py
==================
Manages a pool of up to 10 Gemini API keys with automatic failover.

How it works
------------
- Reads GEMINI_API_KEY_1 … GEMINI_API_KEY_10 from environment (plus the
  legacy GEMINI_API_KEY as a fallback slot).
- Hands out the next available key in round-robin order.
- When a key hits a quota / rate-limit error, it is marked as "cooling down"
  for COOLDOWN_SECONDS and skipped until recovered.
- If ALL keys are cooling down, the caller receives None (caller should return
  a graceful UNCERTAIN / "try again" response).

Usage
-----
    from services.gemini_key_pool import gemini_key_pool

    key = gemini_key_pool.get_key()          # returns a str or None
    gemini_key_pool.mark_failed(key)         # call on quota / rate error
    gemini_key_pool.mark_ok(key)             # optional — resets cooldown early

    # Or use the high-level helper that builds the genai.Client for you:
    client = gemini_key_pool.get_client()    # returns genai.Client or None
    gemini_key_pool.mark_failed_client(client)
"""

import os
import time
import logging
import threading
from typing import Optional

from google import genai

logger = logging.getLogger(__name__)

# Seconds a failed key is skipped before being retried
COOLDOWN_SECONDS = 60

# Signals that indicate a quota / rate-limit error (case-insensitive)
QUOTA_SIGNALS = (
    "quota",
    "rate limit",
    "resource exhausted",
    "429",
    "too many requests",
    "exceeded",
)


class GeminiKeyPool:
    """
    Thread-safe round-robin key pool with per-key cooldown on failure.
    """

    def __init__(self):
        self._lock  = threading.Lock()
        self._keys  = self._load_keys()
        # cooldown_until[key] = monotonic timestamp after which key is usable again
        self._cooldown_until: dict[str, float] = {}
        self._index = 0   # round-robin cursor

        if self._keys:
            logger.info(
                "[KeyPool] Loaded %d Gemini API key(s): %s",
                len(self._keys),
                ", ".join(f"...{k[-4:]}" for k in self._keys),
            )
        else:
            logger.warning("[KeyPool] No Gemini API keys found in environment!")

    # ──────────────────────────────────────────────────────────────────────────
    # Public API
    # ──────────────────────────────────────────────────────────────────────────

    def get_key(self) -> Optional[str]:
        """
        Return the next available key in round-robin order.
        Skips keys that are in cooldown.
        Returns None if all keys are exhausted / cooling down.
        """
        with self._lock:
            if not self._keys:
                return None
            now = time.monotonic()
            n   = len(self._keys)
            for _ in range(n):
                key = self._keys[self._index % n]
                self._index += 1
                if now >= self._cooldown_until.get(key, 0.0):
                    return key
            # All keys cooling down
            logger.error("[KeyPool] All %d key(s) are in cooldown!", n)
            return None

    def mark_failed(self, key: Optional[str]) -> None:
        """
        Mark a key as failed (quota / rate limit).
        It will be skipped for COOLDOWN_SECONDS.
        """
        if not key:
            return
        with self._lock:
            until = time.monotonic() + COOLDOWN_SECONDS
            self._cooldown_until[key] = until
            suffix = key[-4:] if len(key) >= 4 else key
            logger.warning(
                "[KeyPool] Key ...%s marked failed — cooldown for %ds.",
                suffix, COOLDOWN_SECONDS,
            )

    def mark_ok(self, key: Optional[str]) -> None:
        """Reset a key's cooldown early (optional call on success)."""
        if not key:
            return
        with self._lock:
            self._cooldown_until.pop(key, None)

    def get_client(self) -> Optional["_ClientWithKey"]:
        """
        Convenience wrapper: returns a _ClientWithKey (has .client and .key)
        or None if no keys are available.
        """
        key = self.get_key()
        if key is None:
            return None
        client = genai.Client(api_key=key)
        return _ClientWithKey(client=client, key=key, pool=self)

    def is_quota_error(self, exc: Exception) -> bool:
        """Return True if the exception looks like a quota / rate-limit error."""
        msg = str(exc).lower()
        return any(sig in msg for sig in QUOTA_SIGNALS)

    @property
    def key_count(self) -> int:
        return len(self._keys)

    @property
    def available_count(self) -> int:
        now = time.monotonic()
        with self._lock:
            return sum(
                1 for k in self._keys
                if now >= self._cooldown_until.get(k, 0.0)
            )

    # ──────────────────────────────────────────────────────────────────────────
    # Private helpers
    # ──────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _load_keys() -> list[str]:
        """
        Read keys from environment in priority order:
          GEMINI_API_KEY_1 … GEMINI_API_KEY_10
          GEMINI_API_KEY (legacy / single-key fallback)
        Duplicates and blank values are silently dropped.
        """
        seen: set[str] = set()
        keys: list[str] = []

        # Numbered slots first (gives predictable order)
        for i in range(1, 11):
            val = os.environ.get(f"GEMINI_API_KEY_{i}", "").strip()
            if val and val not in seen:
                keys.append(val)
                seen.add(val)

        # Legacy single-key as last fallback
        legacy = os.environ.get("GEMINI_API_KEY", "").strip()
        if legacy and legacy not in seen:
            keys.append(legacy)
            seen.add(legacy)

        return keys


class _ClientWithKey:
    """Thin wrapper pairing a genai.Client with its source key."""

    __slots__ = ("client", "key", "_pool")

    def __init__(self, client: genai.Client, key: str, pool: GeminiKeyPool):
        self.client = client
        self.key    = key
        self._pool  = pool

    def mark_failed(self) -> None:
        self._pool.mark_failed(self.key)

    def mark_ok(self) -> None:
        self._pool.mark_ok(self.key)


# Module-level singleton — import this everywhere
gemini_key_pool = GeminiKeyPool()
