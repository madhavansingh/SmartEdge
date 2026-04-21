"""
Parle-G Biscuit Inspection Service
====================================
Pure OpenCV, zero API calls.

Pipeline
--------
1.  Preprocess   – resize to 640×480, Gaussian blur
2.  Colour mask  – HSV light-yellow / cream range of Parle-G
3.  Contour pick – largest valid contour, area gate
4.  Shape check  – polygon approx 4–6 vertices (rectangle-like)
5.  Aspect ratio – width/height ≈ 1.2 – 2.0
6.  Solidity     – area / convexHullArea; <0.85 → broken
7.  Stripe boost – horizontal dark patterns (Parle-G embossed text)
8.  Decision     – PASS / FAIL / UNCERTAIN with confidence

Key distinction from generic BiscuitService
--------------------------------------------
Parle-G is RECTANGULAR, not round.
The generic service uses circularity; this service uses polygon + aspect ratio.
"""

import logging
import base64
from io import BytesIO
from typing import Dict, Any, List, Tuple

import cv2
import numpy as np
import PIL.Image

logger = logging.getLogger(__name__)

# ─── Tuning constants ────────────────────────────────────────────────────────

TARGET_W, TARGET_H = 640, 480

# HSV colour range for Parle-G (light yellow / cream / golden)
# OpenCV H range 0–179; Parle-G golden is roughly H 10–28
HSV_LOWER = np.array([10,  40, 100])
HSV_UPPER = np.array([28, 255, 255])

# Area gate – contours smaller than this are noise
MIN_CONTOUR_AREA = 4000

# Colour coverage: fraction of image area that must be biscuit-coloured
MIN_COLOR_COVERAGE = 0.04   # 4 %

# Rectangle shape: polygon vertices
RECT_VERTEX_MIN = 4
RECT_VERTEX_MAX = 7         # slightly relaxed (camera angle distortion)

# Aspect ratio of Parle-G biscuit (minAreaRect — rotation-invariant)
# max_dim / min_dim, so always ≥ 1
ASPECT_MIN    = 1.00   # square-ish (flat perspective)
ASPECT_MAX    = 3.50   # foreshortened at steep angle
ASPECT_EXTREME = 4.0   # beyond this → UNCERTAIN (not a biscuit)

# Solidity thresholds
SOLIDITY_PASS_MIN  = 0.88   # above this → intact
SOLIDITY_FAIL_MAX  = 0.82   # below this → broken
# Between 0.82 – 0.88 → UNCERTAIN

# Stripe detection
STRIPE_CONFIDENCE_BOOST = 0.08


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _pil_to_bgr(image: PIL.Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2BGR)


def _encode_annotated(bgr: np.ndarray) -> str:
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    pil = PIL.Image.fromarray(rgb)
    buf = BytesIO()
    pil.save(buf, format="JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _detect_horizontal_stripes(gray_roi: np.ndarray) -> bool:
    """
    Detect horizontal dark line patterns (embossed 'Parle-G' text area).
    Uses horizontal Sobel + row-wise variance check.
    """
    if gray_roi.size == 0:
        return False
    h, w = gray_roi.shape
    if h < 10 or w < 10:
        return False

    sobel_x = cv2.Sobel(gray_roi, cv2.CV_64F, 1, 0, ksize=3)
    sobel_y = cv2.Sobel(gray_roi, cv2.CV_64F, 0, 1, ksize=3)

    # Horizontal stripes show more vertical gradient than horizontal
    mean_x = np.mean(np.abs(sobel_x))
    mean_y = np.mean(np.abs(sobel_y))

    # Also check row variance – stripes create periodic variation
    row_means = np.mean(gray_roi.astype(float), axis=1)
    row_var = np.var(row_means)

    has_y_gradient  = mean_y > mean_x * 1.3
    has_row_variance = row_var > 40.0

    logger.debug("[Parle-G] Stripes: mean_x=%.1f mean_y=%.1f row_var=%.1f", mean_x, mean_y, row_var)
    return has_y_gradient and has_row_variance


# Screen area thresholds
_SCREEN_BRIGHTNESS_THRESH = 200   # V channel; screens are very bright
_SCREEN_MIN_FILL     = 0.12       # screen must occupy ≥12 % of frame
_SCREEN_MAX_FILL     = 0.95       # avoid treating the whole frame as a screen
_SCREEN_VERTEX_MAX   = 8          # relaxed polygon for perspective-distorted screen
_SCREEN_INSET        = 0.06       # crop 6 % inset from each edge (ignore bezel glare)


def _find_screen_roi(bgr: np.ndarray):
    """
    Detect a bright, large rectangular region (phone / monitor screen).

    Returns
    -------
    (x, y, w, h) of the inset crop, or None if no screen is found.
    Detection is intentionally lenient: a false positive just means we
    crop to a sub-region, which is harmless.
    """
    h_img, w_img = bgr.shape[:2]
    total_px = h_img * w_img

    # Threshold on V channel (brightness)
    hsv  = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    _, bright_mask = cv2.threshold(hsv[:, :, 2], _SCREEN_BRIGHTNESS_THRESH, 255, cv2.THRESH_BINARY)

    # Close gaps (bezel, reflections)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    bright_mask = cv2.morphologyEx(bright_mask, cv2.MORPH_CLOSE, kernel, iterations=3)

    contours, _ = cv2.findContours(bright_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    # Pick the largest bright region
    candidate = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(candidate)
    fill = area / total_px

    if not (_SCREEN_MIN_FILL <= fill <= _SCREEN_MAX_FILL):
        logger.debug("[Screen] Bright region fill %.1f%% outside range.", fill * 100)
        return None

    # Must be roughly rectangular
    epsilon = 0.04 * cv2.arcLength(candidate, True)
    approx  = cv2.approxPolyDP(candidate, epsilon, True)
    if len(approx) > _SCREEN_VERTEX_MAX:
        logger.debug("[Screen] Too many vertices (%d) — not a screen.", len(approx))
        return None

    # Axis-aligned bounding rect of the screen + inset
    sx, sy, sw, sh = cv2.boundingRect(candidate)
    inset_x = int(sw * _SCREEN_INSET)
    inset_y = int(sh * _SCREEN_INSET)
    cx  = sx + inset_x
    cy  = sy + inset_y
    cw  = sw - 2 * inset_x
    ch  = sh - 2 * inset_y

    # Sanity: cropped region must be non-trivial
    if cw < 80 or ch < 60:
        return None

    logger.info(
        "[Screen] Detected screen at (%d,%d) %dx%d, fill=%.1f%% — cropping to inner region.",
        sx, sy, sw, sh, fill * 100,
    )
    return (cx, cy, cw, ch)


# ─── Service ─────────────────────────────────────────────────────────────────

class ParleGService:
    _instance = None

    def __new__(cls, *args, **kwargs):
        if not cls._instance:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if hasattr(self, "_initialized"):
            return
        self._initialized = True
        logger.info("ParleGService initialised (rectangular Parle-G detector).")

    # ── Public API ────────────────────────────────────────────────────────────

    def predict(self, image: PIL.Image.Image) -> Dict[str, Any]:
        """
        Analyse one frame for a Parle-G biscuit.

        Returns
        -------
        dict with keys: product_type, status, confidence, message,
                        defects, annotated_image (base64 JPEG)
        """
        if image is None:
            return self._uncertain("No image provided.")

        try:
            return self._run_pipeline(image)
        except Exception as exc:
            logger.exception("[Parle-G] Pipeline crash: %s", exc)
            return self._uncertain("Internal error — please retry.")

    # ── Pipeline ──────────────────────────────────────────────────────────────

    def _run_pipeline(self, image: PIL.Image.Image) -> Dict[str, Any]:

        # ── 1. Preprocess ──────────────────────────────────────────────────
        bgr = _pil_to_bgr(image)
        bgr = cv2.resize(bgr, (TARGET_W, TARGET_H))

        # Screen-mode detection: if the biscuit is displayed on a phone/monitor,
        # crop to the bright screen region so the background doesn’t interfere.
        screen_roi = _find_screen_roi(bgr)
        if screen_roi is not None:
            sx, sy, sw, sh = screen_roi
            bgr = bgr[sy:sy + sh, sx:sx + sw].copy()
            logger.info("[Parle-G] Screen mode: cropped to %dx%d inner region.", sw, sh)

        blurred = cv2.GaussianBlur(bgr, (7, 7), 0)
        hsv  = cv2.cvtColor(blurred, cv2.COLOR_BGR2HSV)
        gray = cv2.cvtColor(blurred, cv2.COLOR_BGR2GRAY)
        logger.debug("[Parle-G] Working resolution: %dx%d", bgr.shape[1], bgr.shape[0])

        annotated = bgr.copy()

        # ── 2. Colour mask ─────────────────────────────────────────────────
        mask = cv2.inRange(hsv, HSV_LOWER, HSV_UPPER)

        # Morphological clean-up
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,  kernel, iterations=1)

        color_coverage = cv2.countNonZero(mask) / (TARGET_W * TARGET_H)
        logger.debug("[Parle-G] Colour coverage: %.2f%%", color_coverage * 100)

        if color_coverage < MIN_COLOR_COVERAGE:
            return self._uncertain(
                f"No Parle-G colour detected (coverage {color_coverage:.1%}). "
                "Ensure the biscuit is visible and well-lit.",
                annotated,
            )

        # ── 3. Contour detection ───────────────────────────────────────────
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        valid = [c for c in contours if cv2.contourArea(c) >= MIN_CONTOUR_AREA]
        if not valid:
            logger.debug("[Parle-G] No valid contours (min area %d).", MIN_CONTOUR_AREA)
            return self._uncertain("Biscuit too small or not detected — adjust distance.", annotated)

        contour = max(valid, key=cv2.contourArea)
        area    = cv2.contourArea(contour)
        logger.debug("[Parle-G] Largest contour area: %.0f", area)

        # Draw contour on annotated image
        cv2.drawContours(annotated, [contour], -1, (0, 200, 255), 2)

        # ── 4. Rectangle shape check ───────────────────────────────────────
        epsilon = 0.02 * cv2.arcLength(contour, True)
        approx  = cv2.approxPolyDP(contour, epsilon, True)
        vertices = len(approx)
        logger.debug("[Parle-G] Polygon vertices: %d", vertices)

        if not (RECT_VERTEX_MIN <= vertices <= RECT_VERTEX_MAX):
            logger.debug("[Parle-G] Non-rectangular shape (%d vertices).", vertices)
            return self._uncertain(
                f"Shape not rectangular ({vertices} vertices detected). "
                "Ensure the biscuit face is parallel to the camera.",
                annotated,
            )

        # ── 5. Aspect ratio (rotation-invariant via minAreaRect) ────────
        # minAreaRect returns the minimum-area bounding box, which is
        # correct even when the biscuit is tilted or viewed at an angle.
        rect  = cv2.minAreaRect(contour)
        rw, rh = rect[1]                           # may be (w,h) or (h,w)
        major = max(rw, rh)
        minor = min(rw, rh)
        aspect = major / max(minor, 1)
        angle  = rect[2]                           # rotation angle (unused, but logged)
        logger.debug("[Parle-G] minAreaRect aspect=%.2f angle=%.1f°", aspect, angle)

        # Draw the rotated bounding box
        box = cv2.boxPoints(rect)
        box = box.astype(int)
        cv2.drawContours(annotated, [box], -1, (255, 180, 0), 2)

        # Also keep axis-aligned rect for ROI cropping later
        x, y, w, h = cv2.boundingRect(contour)

        # Extreme ratio → clearly not a biscuit
        if aspect > ASPECT_EXTREME:
            return self._uncertain(
                f"Aspect ratio {aspect:.2f} is extreme — object too elongated to be a Parle-G.",
                annotated,
            )

        if not (ASPECT_MIN <= aspect <= ASPECT_MAX):
            logger.debug("[Parle-G] Aspect ratio %.2f out of range [%.1f, %.1f].", aspect, ASPECT_MIN, ASPECT_MAX)
            return self._uncertain(
                f"Aspect ratio {aspect:.2f} outside expected range "
                f"({ASPECT_MIN}–{ASPECT_MAX}) for Parle-G.",
                annotated,
            )

        # ── 6. Solidity — defect detection ────────────────────────────────
        hull        = cv2.convexHull(contour)
        hull_area   = cv2.contourArea(hull)
        solidity    = area / max(hull_area, 1)
        logger.debug("[Parle-G] Solidity: %.3f", solidity)

        defects: List[Dict[str, Any]] = []
        if solidity < SOLIDITY_FAIL_MAX:
            # Clearly broken — mark defect points
            hull_idx    = cv2.convexHull(contour, returnPoints=False)
            if hull_idx is not None and len(hull_idx) > 3:
                try:
                    conv_defects = cv2.convexityDefects(contour, hull_idx)
                    if conv_defects is not None:
                        for i in range(conv_defects.shape[0]):
                            _, _, f_idx, depth = conv_defects[i, 0]
                            if depth / 256.0 > 8:
                                pt = tuple(contour[f_idx][0])
                                cv2.circle(annotated, pt, 8, (0, 0, 255), -1)
                                defects.append({"type": "Broken edge", "point": list(pt)})
                except Exception as e:
                    logger.warning("[Parle-G] Convexity defects error: %s", e)

        # ── 7. Horizontal stripe detection (text boost) ───────────────────
        roi_gray = gray[y: y + h, x: x + w]
        has_stripes = _detect_horizontal_stripes(roi_gray)
        logger.debug("[Parle-G] Stripe pattern detected: %s", has_stripes)
        if has_stripes:
            cv2.putText(annotated, "TEXT PATTERN", (x, y - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 128), 1)

        # ── 8. Final decision ─────────────────────────────────────────────
        base_conf = _compute_confidence(color_coverage, solidity, aspect, has_stripes)

        if solidity >= SOLIDITY_PASS_MIN:
            status     = "PASS"
            message    = "Parle-G biscuit detected — no visible defects"
            confidence = base_conf

        elif solidity < SOLIDITY_FAIL_MAX:
            status     = "FAIL"
            message    = f"Broken biscuit detected — solidity {solidity:.2f}"
            confidence = base_conf
            cv2.putText(annotated, "BROKEN", (x, y + h + 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)

        else:
            # 0.82 ≤ solidity < 0.88 → ambiguous
            status     = "UNCERTAIN"
            message    = f"Edge integrity uncertain — solidity {solidity:.2f}"
            confidence = base_conf * 0.7

        logger.info(
            "[Parle-G] Result: %s conf=%.2f solidity=%.2f aspect=%.2f",
            status, confidence, solidity, aspect,
        )

        # Label on image
        colour_map = {"PASS": (0, 220, 80), "FAIL": (0, 0, 220), "UNCERTAIN": (0, 180, 255)}
        cv2.putText(annotated, status, (x, max(y - 12, 12)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, colour_map[status], 2)

        return {
            "product_type":    "Biscuit",
            "object":          "biscuit",
            "status":          status,
            "confidence":      round(float(confidence), 3),
            "message":         message,
            "defects":         defects,
            "solidity":        round(float(solidity), 3),
            "aspect_ratio":    round(float(aspect), 2),
            "stripe_detected": has_stripes,
            "annotated_image": _encode_annotated(annotated),
        }

    # ── Fallback helpers ──────────────────────────────────────────────────────

    def _uncertain(self, message: str, annotated: np.ndarray = None) -> Dict[str, Any]:
        logger.debug("[Parle-G] UNCERTAIN: %s", message)
        result: Dict[str, Any] = {
            "product_type": "Biscuit",
            "object":       "biscuit",
            "status":       "UNCERTAIN",
            "confidence":   0.0,
            "message":      message,
            "defects":      [],
        }
        if annotated is not None:
            result["annotated_image"] = _encode_annotated(annotated)
        return result


# ─── Confidence scorer ────────────────────────────────────────────────────────

def _compute_confidence(
    color_coverage: float,
    solidity: float,
    aspect: float,
    has_stripes: bool,
) -> float:
    """
    Combine individual signals into a single confidence score.

    Weights
    -------
    Colour coverage : 25 %
    Solidity        : 45 %
    Aspect ratio    : 20 %
    Stripe pattern  : 10 % (bonus)
    """
    # Colour: coverage 4–20 % maps to 0–1
    color_score = min(1.0, (color_coverage - MIN_COLOR_COVERAGE) / (0.20 - MIN_COLOR_COVERAGE))

    # Solidity: 0.82 → 0.0,  1.0 → 1.0
    solid_score = max(0.0, (solidity - 0.82) / (1.0 - 0.82))

    # Aspect ratio: ideal midpoint 1.6; penalise deviation
    ideal_aspect = (ASPECT_MIN + ASPECT_MAX) / 2      # ~1.65
    aspect_dev   = abs(aspect - ideal_aspect) / ((ASPECT_MAX - ASPECT_MIN) / 2)
    aspect_score = max(0.0, 1.0 - aspect_dev)

    stripe_bonus = STRIPE_CONFIDENCE_BOOST if has_stripes else 0.0

    raw = (
        color_score  * 0.25 +
        solid_score  * 0.45 +
        aspect_score * 0.20 +
        stripe_bonus
    )
    return round(min(1.0, max(0.0, raw)), 3)


# Module-level singleton
parleg_service = ParleGService()
