"""
Domain Classifier
=================
Pure-OpenCV, zero-API-call heuristic classifier.
Detects whether an image contains a PCB, Biscuit, Automotive part, or Unknown.

Used as the FIRST gate in the pipeline:
  - Confident domain detected  → route to CV service (no Gemini needed)
  - Low-confidence / Unknown   → fall through to Gemini Vision
  - Unknown even after Gemini  → return UNCERTAIN

Detection strategy
------------------
PCB        : dominant green hue + thin-line edge density (circuit traces)
Biscuit    : dominant brown/yellow hue + roughly round/oval major contour
Automotive : metallic (low-saturation, mid-brightness) + large solid contour
Unknown    : none of the above pass their threshold
"""

import logging
from dataclasses import dataclass
from typing import Tuple

import cv2
import numpy as np
import PIL.Image

logger = logging.getLogger(__name__)

# ── Confidence thresholds ──────────────────────────────────────────────────
# Score ≥ HIGH  → confident, skip Gemini
# Score ≥ LOW   → weak match, still use Gemini but seed product_type hint
# Score  < LOW  → Unknown
_CONF_HIGH = 0.55
_CONF_LOW  = 0.30


@dataclass
class DomainResult:
    domain:     str    # "PCB" | "BISCUIT" | "AUTOMOTIVE" | "UNKNOWN"
    confidence: float  # 0.0 – 1.0
    reason:     str
    confident:  bool   # True if score ≥ _CONF_HIGH (skip Gemini)


# ── Internal helpers ──────────────────────────────────────────────────────

def _to_bgr(image: PIL.Image.Image) -> np.ndarray:
    """PIL RGB → OpenCV BGR."""
    return cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2BGR)


def _hue_fraction(hsv: np.ndarray, h_lo: int, h_hi: int,
                   s_lo: int = 40, v_lo: int = 40) -> float:
    """Fraction of pixels within a hue range (with minimum S and V)."""
    mask = cv2.inRange(hsv,
                       np.array([h_lo, s_lo, v_lo]),
                       np.array([h_hi, 255, 255]))
    return float(cv2.countNonZero(mask)) / max(1, hsv.shape[0] * hsv.shape[1])


def _edge_density(gray: np.ndarray) -> float:
    """Fraction of pixels that are edges (Canny). High for PCBs."""
    edges = cv2.Canny(gray, 50, 150)
    return float(cv2.countNonZero(edges)) / max(1, gray.size)


def _largest_contour_circularity(gray: np.ndarray) -> float:
    """
    Circularity of the largest contour: 4π·Area / Perimeter².
    1.0 = perfect circle, 0.0 = line.
    Returns 0.0 if no contour found.
    """
    blurred = cv2.GaussianBlur(gray, (7, 7), 0)
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 0.0
    largest = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(largest)
    peri = cv2.arcLength(largest, True)
    if peri == 0:
        return 0.0
    return min(1.0, (4 * np.pi * area) / (peri ** 2))


def _saturation_mean(hsv: np.ndarray) -> float:
    """Mean saturation (0–1). Low = metallic/grey surfaces."""
    return float(hsv[:, :, 1].mean()) / 255.0


# ── Per-domain scorers ────────────────────────────────────────────────────

def _score_pcb(hsv: np.ndarray, gray: np.ndarray) -> Tuple[float, str]:
    """
    PCB heuristics:
      • Green hue (H 35–85 in OpenCV scale) dominates
      • High edge density (dense circuit traces)
    """
    green_frac  = _hue_fraction(hsv, 35, 85, s_lo=30, v_lo=30)
    edge_dens   = _edge_density(gray)

    # Edge density for PCBs typically 0.08–0.25; biscuits < 0.06
    edge_score  = min(1.0, edge_dens / 0.15)
    color_score = min(1.0, green_frac / 0.20)   # 20 % green pixels → full score

    score  = color_score * 0.55 + edge_score * 0.45
    reason = (
        f"Green fraction {green_frac:.1%}, "
        f"edge density {edge_dens:.1%}"
    )
    return round(score, 3), reason


def _score_biscuit(hsv: np.ndarray, gray: np.ndarray) -> Tuple[float, str]:
    """
    Biscuit heuristics:
      • Brown / yellow / warm hue (H 5–35 in OpenCV 0-179 scale)
      • Roughly circular largest contour
    """
    warm_frac   = _hue_fraction(hsv, 5, 35, s_lo=25, v_lo=40)
    circularity = _largest_contour_circularity(gray)

    color_score = min(1.0, warm_frac / 0.25)   # 25 % warm pixels → full score
    shape_score = min(1.0, circularity / 0.65)  # circularity ≥ 0.65 → full score

    score  = color_score * 0.60 + shape_score * 0.40
    reason = (
        f"Warm-tone fraction {warm_frac:.1%}, "
        f"contour circularity {circularity:.2f}"
    )
    return round(score, 3), reason


def _score_automotive(hsv: np.ndarray, gray: np.ndarray) -> Tuple[float, str]:
    """
    Automotive heuristics:
      • Low saturation  (metallic, grey, unpainted surfaces)
      • Large solid contour relative to frame (substantial object)
    """
    sat_mean = _saturation_mean(hsv)
    # Metallic surfaces: sat < 0.35
    metal_score = max(0.0, 1.0 - sat_mean / 0.35)

    # Largest contour area relative to image
    h, w = gray.shape
    blurred = cv2.GaussianBlur(gray, (7, 7), 0)
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if contours:
        largest_area = cv2.contourArea(max(contours, key=cv2.contourArea))
        fill_frac = largest_area / max(1, h * w)
    else:
        fill_frac = 0.0

    size_score = min(1.0, fill_frac / 0.20)   # ≥ 20 % fill → full score

    score  = metal_score * 0.55 + size_score * 0.45
    reason = (
        f"Mean saturation {sat_mean:.2f} (low=metallic), "
        f"contour fill {fill_frac:.1%}"
    )
    return round(score, 3), reason


# ── Public classifier ──────────────────────────────────────────────────────

def classify_domain(image: PIL.Image.Image) -> DomainResult:
    """
    Classify the image domain using pure OpenCV heuristics.

    Returns DomainResult with:
      domain     : "PCB" | "BISCUIT" | "AUTOMOTIVE" | "UNKNOWN"
      confidence : 0.0 – 1.0
      reason     : human-readable diagnostic string
      confident  : True if confidence ≥ _CONF_HIGH (can skip Gemini)
    """
    try:
        bgr  = _to_bgr(image)
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        hsv  = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)

        pcb_score,  pcb_reason  = _score_pcb(hsv, gray)
        bis_score,  bis_reason  = _score_biscuit(hsv, gray)
        auto_score, auto_reason = _score_automotive(hsv, gray)

        scores = {
            "PCB":        (pcb_score,  pcb_reason),
            "BISCUIT":    (bis_score,  bis_reason),
            "AUTOMOTIVE": (auto_score, auto_reason),
        }

        best_domain, (best_score, best_reason) = max(scores.items(), key=lambda x: x[1][0])

        logger.debug(
            "[DOMAIN] PCB=%.2f  BISCUIT=%.2f  AUTO=%.2f  → %s (%.2f)",
            pcb_score, bis_score, auto_score, best_domain, best_score,
        )

        if best_score < _CONF_LOW:
            return DomainResult(
                domain="UNKNOWN",
                confidence=best_score,
                reason=f"No domain matched. Best was {best_domain} at {best_score:.0%}.",
                confident=False,
            )

        return DomainResult(
            domain=best_domain,
            confidence=best_score,
            reason=best_reason,
            confident=best_score >= _CONF_HIGH,
        )

    except Exception as exc:
        logger.exception("[DOMAIN] classifier crashed: %s", exc)
        return DomainResult(
            domain="UNKNOWN",
            confidence=0.0,
            reason="Domain classifier error.",
            confident=False,
        )
