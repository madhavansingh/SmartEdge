"""
Decision Engine
===============
Post-processes inspection results from CV services and Gemini Vision.

Responsibilities
----------------
1. Enforce per-domain decision rules (no false FAIL, no forced 0 confidence).
2. Normalise reason strings to human-readable copy.
3. Apply 3-frame majority voting per user_id for stable live-mode output.

Does NOT re-run CV logic — it only validates and smooths the result it receives.
"""

import logging
from collections import deque
from threading import Lock
from typing import Dict, Any, Deque

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------

VOTE_WINDOW      = 3      # frames kept for majority voting
CONF_FLOOR       = 0.30   # minimum confidence for any non-UNCERTAIN result
CONF_UNCERTAIN   = 0.25   # below this → force UNCERTAIN regardless of status

# Human-readable canonical reason strings shown in the UI
_REASONS: Dict[str, str] = {
    "pass_default":       "No visible defect detected",
    "fail_broken":        "Detected broken edge or damage",
    "fail_defect":        "Defect detected — manual review required",
    "uncertain_unclear":  "Unable to determine — please adjust camera",
    "uncertain_mismatch": "Object not matching expected category",
    "uncertain_quality":  "Image quality too low to analyse",
    "uncertain_busy":     "AI service busy — please wait a moment",
}


def _canonical_reason(raw: str, status: str) -> str:
    """
    Map raw service reason strings to clean, operator-facing copy.
    Falls back to the raw string if no mapping matches.
    """
    if not raw:
        return _REASONS["pass_default"] if status == "PASS" else _REASONS["uncertain_unclear"]

    lower = raw.lower()

    # Busy / quota
    if any(w in lower for w in ("busy", "quota", "rate limit", "service")):
        return _REASONS["uncertain_busy"]

    # Quality
    if any(w in lower for w in ("quality", "blurry", "dark", "bright")):
        return _REASONS["uncertain_quality"]

    # Mismatch
    if any(w in lower for w in ("mismatch", "not matching", "not in supported", "category")):
        return _REASONS["uncertain_mismatch"]

    # Fail reasons
    if status == "FAIL":
        if any(w in lower for w in ("broken", "crack", "edge", "missing")):
            return _REASONS["fail_broken"]
        return _REASONS["fail_defect"]

    # Pass default
    if status == "PASS" and any(w in lower for w in ("no defect", "no visible", "intact", "normal", "no damage")):
        return _REASONS["pass_default"]

    return raw  # use original if no mapping hit


def _confidence_floor(result: Dict[str, Any]) -> Dict[str, Any]:
    """
    Enforce minimum confidence values per status.
    - PASS  should never be 0.0 confidence (the CV service reported something)
    - FAIL  should never be 0.0 confidence (same reason)
    - UNCERTAIN  is allowed to be low
    Never force a status change — only raise/floor the number.
    """
    result = dict(result)
    status = result.get("status", "UNCERTAIN")
    conf   = float(result.get("confidence", 0.0))

    if status == "UNCERTAIN" and conf < CONF_UNCERTAIN:
        # Already uncertain, keep it — just make sure conf isn't negative
        result["confidence"] = max(0.0, conf)
        return result

    # If status is PASS or FAIL but confidence is suspiciously low → downgrade
    if status in ("PASS", "FAIL") and conf < CONF_UNCERTAIN:
        result["status"]     = "UNCERTAIN"
        result["confidence"] = conf
        result["reason"]     = _REASONS["uncertain_unclear"]
        logger.debug("[Engine] Downgraded to UNCERTAIN (conf=%.2f too low for %s)", conf, status)
        return result

    # Apply floor for non-UNCERTAIN statuses
    if status in ("PASS", "FAIL") and conf < CONF_FLOOR:
        result["confidence"] = CONF_FLOOR
        logger.debug("[Engine] Raised confidence floor to %.2f for %s", CONF_FLOOR, status)

    return result


# ---------------------------------------------------------------------------
# MAJORITY VOTER  (per-user, thread-safe)
# ---------------------------------------------------------------------------

class _MajorityVoter:
    """Sliding window majority vote over the last VOTE_WINDOW results."""

    def __init__(self):
        self._lock:    Lock = Lock()
        self._windows: Dict[str, Deque[Dict[str, Any]]] = {}

    def vote(self, user_id: str, result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Add result to the window, then return the majority-voted result.
        The winning result dict is the actual result object (not a synthetic one),
        so all fields (reason, defects, etc.) stay coherent.
        """
        with self._lock:
            if user_id not in self._windows:
                self._windows[user_id] = deque(maxlen=VOTE_WINDOW)
            window = self._windows[user_id]
            window.append(result)

            # Count votes per status
            counts: Dict[str, int] = {}
            for r in window:
                s = r.get("status", "UNCERTAIN")
                counts[s] = counts.get(s, 0) + 1

            majority_status = max(counts, key=counts.__getitem__)
            majority_count  = counts[majority_status]

            # Pick the result from the window that matches the majority status
            # and has the highest confidence (most informative)
            candidates = [r for r in window if r.get("status") == majority_status]
            best = max(candidates, key=lambda r: r.get("confidence", 0.0))

            logger.debug(
                "[Vote] user=%s window=%s counts=%s → %s (%d/%d)",
                user_id, [r.get("status") for r in window],
                counts, majority_status, majority_count, len(window),
            )

            voted = dict(best)
            voted["vote_count"]   = majority_count
            voted["vote_window"]  = len(window)
            return voted

    def reset(self, user_id: str) -> None:
        with self._lock:
            self._windows.pop(user_id, None)


_voter = _MajorityVoter()


# ---------------------------------------------------------------------------
# PUBLIC API
# ---------------------------------------------------------------------------

def apply(
    result: Dict[str, Any],
    user_id: str = "default",
    use_voting: bool = True,
) -> Dict[str, Any]:
    """
    Apply the full decision engine pipeline to a raw inspection result.

    Steps
    -----
    1. Confidence floor — no PASS/FAIL at 0 confidence.
    2. Canonical reason strings.
    3. Majority voting (last 3 frames, per user_id).

    Parameters
    ----------
    result     : raw result dict from a CV service or Gemini Vision
    user_id    : identifies the live-mode user/camera (for voting state)
    use_voting : set False for single-shot (batch) scans

    Returns
    -------
    Smoothed, normalised result dict with extra fields:
      vote_count, vote_window  (when use_voting=True)
    """
    try:
        # Step 1: confidence floor + downgrade if necessary
        result = _confidence_floor(result)

        # Step 2: normalise reason string
        result["reason"] = _canonical_reason(
            result.get("reason") or result.get("message") or "",
            result.get("status", "UNCERTAIN"),
        )

        # Step 3: majority voting for live mode
        if use_voting:
            result = _voter.vote(user_id, result)
        else:
            result.setdefault("vote_count",  1)
            result.setdefault("vote_window", 1)

        return result

    except Exception as exc:
        logger.exception("[Engine] apply() crashed: %s", exc)
        # Absolute last-resort fallback
        return {
            **result,
            "status":     "UNCERTAIN",
            "confidence": 0.0,
            "reason":     _REASONS["uncertain_unclear"],
            "vote_count":  1,
            "vote_window": 1,
        }


def reset_voter(user_id: str) -> None:
    """Call when live mode is stopped to clear stale vote history."""
    _voter.reset(user_id)
