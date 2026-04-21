"""
Gemini Vision Service  (production-grade, tolerant)
====================================================
Features
--------
- Lenient inspection prompt  → prefers PASS over FAIL
- Tiered confidence  : <0.3 UNCERTAIN | 0.3-0.6 low | >0.6 normal
- Biscuit-like rescue: UNCERTAIN biscuit-like object → PASS (low confidence)
- Relaxed object matching : substring + synonym matching
- Per-user rate limiting  : 3 s gap
- Image hash caching      : identical frame → return previous result
- 1 auto-retry on quota/rate errors (2 s sleep)
- NEVER crashes, NEVER returns "Model call failed"
- Structured log tags on every code path
"""

import os
import json
import time
import hashlib
import logging
from io import BytesIO
from typing import Dict, Any, Optional
from threading import Lock

import PIL.Image
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------

GEMINI_API_KEY       = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL         = "gemini-2.0-flash-lite"   # best free-tier rate limits

RATE_LIMIT_SECONDS   = 3        # min gap per user  (matches frontend 3 s loop)
RETRY_WAIT_SECONDS   = 2        # sleep before 1 retry on quota error
MAX_RETRIES          = 1        # only 1 retry, then graceful fallback
CACHE_MAX_SIZE       = 128      # FIFO eviction

# Tiered confidence thresholds
CONF_UNCERTAIN_BELOW = 0.30    # below → force UNCERTAIN
CONF_LOW_BELOW       = 0.60    # 0.30–0.60 → accept but annotate low confidence
# above 0.60 → accept normally

# Strings that signal a quota / rate-limit exception
_QUOTA_SIGNALS = ("quota", "rate limit", "resource exhausted", "429", "too many requests")

# Object synonym tables for relaxed matching
PRODUCT_KEYWORDS: Dict[str, list] = {
    "PCB":        ["pcb", "circuit board", "printed circuit", "electronic board", "board", "chip"],
    "BISCUIT":    ["biscuit", "cookie", "cracker", "snack", "wafer", "bread", "pastry",
                   "baked", "round", "disc", "food"],
    "AUTOMOTIVE": ["car part", "automotive", "brake", "gear", "piston", "bearing",
                   "valve", "engine", "auto part", "metal part"],
}

# Objects that are "biscuit-like" even if model doesn't say "biscuit" exactly
_BISCUIT_LIKE = ("biscuit", "cookie", "cracker", "wafer", "snack", "food", "pastry",
                 "round", "bread", "disc")

# ---------------------------------------------------------------------------
# LENIENT INSPECTION PROMPT
# ---------------------------------------------------------------------------

INSPECTION_PROMPT = """\
You are an industrial quality inspection assistant.

Analyze the image carefully.

Steps:
1. Identify the object: biscuit, car part, PCB, or unknown.
   - If the object resembles a biscuit (round, brown, textured, food item), classify it as "biscuit".

2. Determine quality:
   - PASS  = no visible damage, cracks, or defects
   - FAIL  = clearly broken, cracked, or visibly damaged
   - UNCERTAIN = image is unclear, object is unknown, or you cannot decide

Rules (IMPORTANT):
- Be lenient. Do NOT be overly strict.
- Prefer PASS if there is no obvious, clearly visible defect.
- Only return FAIL if damage is unmistakably visible.
- If the object looks generally okay or you are unsure → return PASS or UNCERTAIN.
- If completely unclear → return UNCERTAIN, never guess FAIL.

Return ONLY valid JSON, no markdown, no extra text:
{
  "object": "biscuit | car part | pcb | unknown",
  "status": "PASS | FAIL | UNCERTAIN",
  "confidence": 0.0,
  "reason": "short explanation, max 20 words"
}
"""

# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------

def _image_hash(image: PIL.Image.Image) -> str:
    """MD5 of downsampled JPEG bytes — fast, good enough for cache keying."""
    buf = BytesIO()
    image.save(buf, format="JPEG", quality=60)
    return hashlib.md5(buf.getvalue()).hexdigest()


def _parse_gemini_response(text: str) -> Optional[Dict[str, Any]]:
    """
    Safely parse JSON from Gemini output.
    Strips markdown fences, validates required fields, normalises values.
    """
    text = text.strip()
    # Strip ```json ... ``` fences
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(l for l in lines if not l.startswith("```")).strip()

    # Extract JSON object if extra text is present
    start = text.find("{")
    end   = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start:end+1]

    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None

    # Validate required fields
    if not all(k in data for k in ("object", "status", "confidence", "reason")):
        return None

    # Normalise status
    data["status"] = str(data.get("status", "UNCERTAIN")).upper().strip()
    if data["status"] not in ("PASS", "FAIL", "UNCERTAIN"):
        data["status"] = "UNCERTAIN"

    # Clamp confidence
    try:
        data["confidence"] = round(max(0.0, min(1.0, float(data["confidence"]))), 3)
    except (TypeError, ValueError):
        data["confidence"] = 0.0

    # Sanitise object name
    data["object"] = str(data.get("object", "unknown")).lower().strip()

    # Sanitise reason
    data["reason"] = str(data.get("reason", "")).strip()[:200]

    return data


def _uncertain(reason: str, obj: str = "unknown") -> Dict[str, Any]:
    """Always-safe UNCERTAIN response — used as fallback on any failure."""
    return {
        "object":     obj,
        "status":     "UNCERTAIN",
        "confidence": 0.0,
        "reason":     reason,
    }


# ---------------------------------------------------------------------------
# SERVICE
# ---------------------------------------------------------------------------

class GeminiVisionService:
    """
    Singleton Gemini Vision service.
    Thread-safe, tolerant, always returns a valid response dict.
    """

    _instance = None

    def __new__(cls, *args, **kwargs):
        if not cls._instance:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if hasattr(self, "_initialized"):
            return
        self._initialized = True

        if GEMINI_API_KEY:
            self._client = genai.Client(api_key=GEMINI_API_KEY)
            logger.info("GeminiVisionService: client ready, model='%s'.", GEMINI_MODEL)
        else:
            self._client = None
            logger.warning(
                "GeminiVisionService: GEMINI_API_KEY not set — "
                "all requests will return UNCERTAIN."
            )

        self._rate_lock:  Lock = Lock()
        self._last_call:  Dict[str, float] = {}
        self._cache_lock: Lock = Lock()
        self._cache:      Dict[str, Dict[str, Any]] = {}

    # ------------------------------------------------------------------
    # PUBLIC API
    # ------------------------------------------------------------------

    def analyze(
        self,
        image: PIL.Image.Image,
        product_type: str = "UNKNOWN",
        user_id: str = "default",
    ) -> Dict[str, Any]:
        """
        Analyze an image. Always returns:
            {object, status, confidence, reason, cached, skipped_api}
        Never raises. Never returns "Model call failed".
        """
        try:
            product_type_upper = product_type.upper()

            # ── Step 1: Cache lookup ───────────────────────────────────────
            img_hash = _image_hash(image)
            cached = self._get_cache(img_hash)
            if cached:
                result = dict(cached)
                result["cached"]      = True
                result["skipped_api"] = False
                logger.info("[CACHE_HIT] hash=%s user=%s", img_hash[:8], user_id)
                return self._apply_filters(result, product_type_upper)

            # ── Step 2: Per-user rate limit ────────────────────────────────
            if not self._check_rate_limit(user_id):
                logger.warning("[RATE_LIMITED] user=%s (gap < %ss)", user_id, RATE_LIMIT_SECONDS)
                return {
                    **_uncertain("Rate limited — please wait a moment."),
                    "cached": False,
                    "skipped_api": True,
                }

            # ── Step 3: API key guard ──────────────────────────────────────
            if self._client is None:
                logger.error("[NO_API_KEY] Gemini client not initialised.")
                return {
                    **_uncertain("Gemini API key not configured."),
                    "cached": False,
                    "skipped_api": True,
                }

            # ── Step 4: Call Gemini (with retry) ──────────────────────────
            logger.info("[API_CALL] user=%s hash=%s product=%s", user_id, img_hash[:8], product_type_upper)
            result = self._call_with_retry(image)

            # ── Step 5: Cache & decorate ───────────────────────────────────
            self._set_cache(img_hash, result)
            result["cached"]      = False
            result["skipped_api"] = False

            # ── Step 6: Apply smart filters ────────────────────────────────
            final = self._apply_filters(result, product_type_upper)
            logger.info(
                "[RESULT] user=%s status=%s conf=%.2f object=%s",
                user_id, final.get("status"), final.get("confidence", 0), final.get("object"),
            )
            return final

        except Exception as exc:
            logger.exception("[CRASH] GeminiVisionService.analyze: %s", exc)
            return {
                **_uncertain("Low confidence — please adjust camera and retry."),
                "cached": False,
                "skipped_api": False,
            }

    # ------------------------------------------------------------------
    # FILTERS  (lenient, tiered confidence, biscuit-like rescue)
    # ------------------------------------------------------------------

    def _apply_filters(self, result: Dict[str, Any], product_type: str) -> Dict[str, Any]:
        result = dict(result)
        conf   = result.get("confidence", 0.0)
        status = result.get("status", "UNCERTAIN")
        obj    = result.get("object", "unknown").lower()

        # ── Filter 1: Tiered confidence ────────────────────────────────────
        if conf < CONF_UNCERTAIN_BELOW and status != "UNCERTAIN":
            result["status"] = "UNCERTAIN"
            result["reason"] = (
                f"Low confidence ({conf:.0%}) — " + result.get("reason", "")
            ).strip()

        elif CONF_UNCERTAIN_BELOW <= conf < CONF_LOW_BELOW and status not in ("UNCERTAIN",):
            # Accept, but annotate as low-confidence
            result["reason"] = (
                f"[Low confidence {conf:.0%}] " + result.get("reason", "")
            ).strip()

        # ── Filter 2: Relaxed object-type matching ─────────────────────────
        if product_type in PRODUCT_KEYWORDS:
            keywords = PRODUCT_KEYWORDS[product_type]
            is_match    = any(kw in obj for kw in keywords)
            is_unknown  = obj in ("unknown", "", "none", "object")

            if not is_match and not is_unknown:
                # Mismatch — only downgrade to UNCERTAIN, do not force FAIL
                result["status"]     = "UNCERTAIN"
                result["reason"]     = (
                    f"Object mismatch — detected '{obj}', "
                    f"expected {product_type.lower()}."
                )
                result["confidence"] = min(conf, 0.4)

        # ── Filter 3: Biscuit-like rescue ──────────────────────────────────
        # If result is UNCERTAIN but object looks like a biscuit and we
        # are inspecting biscuits → assume PASS with low confidence
        # (better than leaving operator with no information)
        if (
            result["status"] == "UNCERTAIN"
            and product_type == "BISCUIT"
            and any(kw in obj for kw in _BISCUIT_LIKE)
            and result.get("confidence", 0) >= 0.15
        ):
            result["status"]     = "PASS"
            result["confidence"] = max(result.get("confidence", 0.3), 0.3)
            result["reason"]     = (
                "Biscuit detected, no obvious defect visible. "
                "Low confidence — verify manually."
            )
            logger.info("[BISCUIT_RESCUE] Converted UNCERTAIN biscuit → PASS")

        return result

    # ------------------------------------------------------------------
    # GEMINI CALL WITH RETRY
    # ------------------------------------------------------------------

    def _call_with_retry(self, image: PIL.Image.Image) -> Dict[str, Any]:
        """
        Retry flow:
          Attempt 1 → quota/rate error → sleep 2 s → Attempt 2
          Attempt 2 → still fails → return UNCERTAIN (friendly message)
        """
        for attempt in range(1, MAX_RETRIES + 2):
            try:
                result = self._call_gemini(image)

                # Detect if the result itself signals a quota issue
                reason_lower = result.get("reason", "").lower()
                if (
                    result.get("status") == "UNCERTAIN"
                    and any(sig in reason_lower for sig in _QUOTA_SIGNALS)
                    and attempt <= MAX_RETRIES
                ):
                    logger.warning(
                        "[RETRY] Quota signal in response, attempt %d/%d — sleeping %ss.",
                        attempt, MAX_RETRIES + 1, RETRY_WAIT_SECONDS,
                    )
                    time.sleep(RETRY_WAIT_SECONDS)
                    continue

                return result

            except Exception as exc:
                err_lower = str(exc).lower()
                if any(sig in err_lower for sig in _QUOTA_SIGNALS) and attempt <= MAX_RETRIES:
                    logger.warning(
                        "[RETRY] Quota error attempt %d/%d: %s — sleeping %ss.",
                        attempt, MAX_RETRIES + 1, exc, RETRY_WAIT_SECONDS,
                    )
                    time.sleep(RETRY_WAIT_SECONDS)
                    continue

                logger.error("[API_ERROR] Gemini call failed (attempt %d): %s", attempt, exc)
                # Return a friendly uncertain — never expose internal error text
                return _uncertain("Low confidence — please adjust camera and retry.")

        logger.error("[RETRY_EXHAUSTED] All %d attempts failed.", MAX_RETRIES + 1)
        return _uncertain("AI service busy — result unavailable. Please wait.")

    def _call_gemini(self, image: PIL.Image.Image) -> Dict[str, Any]:
        """
        Single Gemini Vision call.
        Resizes image, sends prompt, parses JSON.
        Does NOT catch exceptions — caller handles retry logic.
        """
        # Resize to keep token cost low
        max_dim = 1024
        w, h = image.size
        if max(w, h) > max_dim:
            ratio = max_dim / max(w, h)
            image = image.resize((int(w * ratio), int(h * ratio)), PIL.Image.LANCZOS)

        rgb_image = image.convert("RGB")

        response = self._client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[INSPECTION_PROMPT, rgb_image],
            config=types.GenerateContentConfig(
                temperature=0.1,
                max_output_tokens=256,
            ),
        )

        raw_text = (response.text or "").strip()
        logger.debug("[GEMINI_RAW] %.200s", raw_text)

        parsed = _parse_gemini_response(raw_text)
        if parsed:
            return parsed

        logger.warning("[PARSE_FAIL] %.120s", raw_text)
        return _uncertain("Unable to read model response — please try again.")

    # ------------------------------------------------------------------
    # RATE LIMITER
    # ------------------------------------------------------------------

    def _check_rate_limit(self, user_id: str) -> bool:
        now = time.monotonic()
        with self._rate_lock:
            last = self._last_call.get(user_id, 0.0)
            if now - last < RATE_LIMIT_SECONDS:
                return False
            self._last_call[user_id] = now
            return True

    # ------------------------------------------------------------------
    # CACHE
    # ------------------------------------------------------------------

    def _get_cache(self, key: str) -> Optional[Dict[str, Any]]:
        with self._cache_lock:
            return self._cache.get(key)

    def _set_cache(self, key: str, value: Dict[str, Any]) -> None:
        with self._cache_lock:
            if len(self._cache) >= CACHE_MAX_SIZE:
                del self._cache[next(iter(self._cache))]   # FIFO eviction
            self._cache[key] = value


# Module-level singleton
gemini_vision_service = GeminiVisionService()
