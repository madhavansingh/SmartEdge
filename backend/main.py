import io
import os
import ssl
import time
import asyncio
import logging

# ── SSL cert fix for macOS dev environments ──────────────────────────────────
# Ensures Google token verification works even when system certs are missing.
try:
    import certifi
    ssl._create_default_https_context = ssl.create_default_context(cafile=certifi.where())
except Exception:
    # If certifi isn't installed or the above fails, fall back to unverified (dev only)
    ssl._create_default_https_context = ssl._create_unverified_context
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, File, UploadFile, HTTPException, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from PIL import Image
from typing import List, Optional
from pydantic import BaseModel


# ── Structured logger ────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("smartedge")

# ── Constants ────────────────────────────────────────────────────────────────
MAX_FILE_BYTES   = 15 * 1024 * 1024   # 15 MB hard limit
AI_TIMEOUT_SEC   = 28                  # max seconds to wait for Gemini/CV
RATE_LIMIT_SEC   = 2.0                 # min seconds between requests per user_id
_rate_store: dict[str, float] = {}     # user_id → last request timestamp
from utils.image_quality import ImagePreprocessor

# Load .env from the same directory as this file (backend/.env)
# so the server works regardless of which directory it is started from
try:
    from dotenv import load_dotenv
    _env_path = Path(__file__).parent / ".env"
    load_dotenv(dotenv_path=_env_path)
    print(f"[ENV] Loaded: {_env_path}")
except ImportError:
    pass

preprocessor = ImagePreprocessor()

import numpy as _np

def _safe_json(obj):
    """
    Recursively convert numpy scalars / bools to native Python types so that
    fastapi.responses.JSONResponse (stdlib json) never hits 'not serializable'.
    """
    if isinstance(obj, dict):
        return {k: _safe_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_safe_json(v) for v in obj]
    if isinstance(obj, _np.integer):
        return int(obj)
    if isinstance(obj, _np.floating):
        return float(obj)
    if isinstance(obj, _np.bool_):
        return bool(obj)
    if isinstance(obj, _np.ndarray):
        return obj.tolist()
    return obj

# Import the service layers
from services.pcb_service import pcb_service
from services.biscuit_service import biscuit_service   # kept for backward compat
from services.parleg_service import parleg_service
from services.automotive_service import automotive_service
from services.gemini_vision_service import gemini_vision_service
from services.domain_classifier import classify_domain
from services import decision_engine

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load all models at startup to optimize for fast response
    print("Starting up: Loading models into memory...")
    try:
        pcb_service._load_model()
        automotive_service._load_model()
        # parleg_service is pure OpenCV — no model file to load
        # domain_classifier is pure OpenCV — no model file to load
        print("Models loaded successfully.")
    except Exception as e:
        print(f"Warning: Model loading issue at startup: {str(e)}")
    yield

app = FastAPI(title="SmartEdge AI Inspector API", version="1.0.0", lifespan=lifespan)

# Enable CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust this in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {"status": "ok", "service": "SmartEdge AI Inspector API"}


@app.get("/server-info")
async def server_info():
    """
    Returns the server's LAN IP address so the frontend can generate correct
    QR codes without relying on a hardcoded VITE_LAN_IP env var.
    """
    import socket
    try:
        # Connect to an external host (no data sent) to find the active interface IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        lan_ip = s.getsockname()[0]
        s.close()
    except Exception:
        lan_ip = "127.0.0.1"
    return {"lan_ip": lan_ip}


# ── Global exception handler — catches any unhandled 500 ─────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    log.error("Unhandled exception on %s: %s", request.url.path, exc, exc_info=True)
    return JSONResponse(
        status_code=200,   # always 200 so frontend parses JSON cleanly
        content={
            "status":       "UNCERTAIN",
            "object":       "unknown",
            "confidence":   0.0,
            "reason":       "Something went wrong — please retry.",
            "cached":       False,
            "skipped_api":  False,
        },
    )

@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    log.warning("HTTP %s on %s: %s", exc.status_code, request.url.path, exc.detail)
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


# ── Shared helpers ────────────────────────────────────────────────────────────

def _check_rate_limit(user_id: str) -> bool:
    """Return True if request is allowed, False if rate-limited."""
    now = time.time()
    last = _rate_store.get(user_id, 0.0)
    if now - last < RATE_LIMIT_SEC:
        return False
    _rate_store[user_id] = now
    return True

def _validate_file_size(data: bytes, endpoint: str) -> bool:
    """Return True if file is within size limit."""
    if len(data) > MAX_FILE_BYTES:
        log.warning("[%s] File too large: %d bytes (limit %d)", endpoint, len(data), MAX_FILE_BYTES)
        return False
    return True

async def _run_with_timeout(coro_or_callable, *args, timeout: float = AI_TIMEOUT_SEC, **kwargs):
    """
    Run a sync or async callable with a timeout.
    Falls back to UNCERTAIN dict on TimeoutError.
    """
    import concurrent.futures
    loop = asyncio.get_event_loop()
    if asyncio.iscoroutinefunction(coro_or_callable):
        try:
            return await asyncio.wait_for(coro_or_callable(*args, **kwargs), timeout=timeout)
        except asyncio.TimeoutError:
            log.warning("AI call timed out after %ss", timeout)
            return None
    else:
        # Sync function — run in thread pool so we don't block the event loop
        try:
            return await asyncio.wait_for(
                loop.run_in_executor(None, lambda: coro_or_callable(*args, **kwargs)),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            log.warning("AI call (sync) timed out after %ss", timeout)
            return None




# ═══════════════════════════════════════════════════════════════════════════
# GOOGLE AUTH
# ═══════════════════════════════════════════════════════════════════════════
import uuid
import urllib.request
import json as _json

_sessions: dict = {}   # session_token → user_info

_GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")

# Try to import google-auth library for robust token verification.
# Falls back to urllib + tokeninfo endpoint if not installed.
try:
    from google.oauth2 import id_token as _google_id_token
    from google.auth.transport import requests as _google_requests
    _GOOGLE_AUTH_AVAILABLE = True
except ImportError:
    _GOOGLE_AUTH_AVAILABLE = False


def _verify_google_token(token: str) -> dict:
    """
    Verify a Google ID token and return the decoded claims.
    Tries google-auth library first, then falls back to Google's tokeninfo URL.
    Raises ValueError on any verification failure.
    """
    # ── Strategy 1: google-auth library (preferred) ──────────────────────────
    if _GOOGLE_AUTH_AVAILABLE:
        try:
            request = _google_requests.Request()
            idinfo = _google_id_token.verify_oauth2_token(
                token,
                request,
                _GOOGLE_CLIENT_ID or None,  # None = skip audience check
            )
            return idinfo
        except Exception as e:
            log.warning("google-auth library verification failed, trying tokeninfo: %s", e)
            # Fall through to urllib strategy below

    # ── Strategy 2: tokeninfo endpoint via urllib (SSL-patched) ─────────────
    url = f"https://oauth2.googleapis.com/tokeninfo?id_token={token}"
    ctx = ssl._create_default_https_context()  # uses certifi or unverified (already patched above)
    try:
        with urllib.request.urlopen(url, timeout=10, context=ctx) as resp:
            info = _json.loads(resp.read().decode())
    except Exception as e:
        raise ValueError(f"Network error reaching Google tokeninfo: {e}")

    if info.get("error"):
        raise ValueError(f"Google tokeninfo error: {info['error']}") 

    return info


@app.post("/auth/google")
async def google_auth(payload: dict):
    """
    Receives a Google ID token from the frontend, verifies it,
    and returns a session token + user profile.
    Robust: works without system CA certs via certifi / unverified fallback.
    """
    raw_token = payload.get("credential") or payload.get("id_token", "")
    if not raw_token:
        raise HTTPException(status_code=400, detail="Missing credential")

    try:
        info = _verify_google_token(raw_token)
    except Exception as e:
        log.warning("Google token verification failed: %s", e)
        return JSONResponse(
            status_code=401,
            content={"status": "error", "message": "Token verification failed"},
        )

    # Validate audience if client ID is configured and library didn't already check it
    if _GOOGLE_CLIENT_ID and not _GOOGLE_AUTH_AVAILABLE:
        if info.get("aud") != _GOOGLE_CLIENT_ID:
            return JSONResponse(
                status_code=401,
                content={"status": "error", "message": "Token audience mismatch"},
            )

    user = {
        "name":    info.get("name", ""),
        "email":   info.get("email", ""),
        "picture": info.get("picture", ""),
        "sub":     info.get("sub", ""),
    }

    session_token = str(uuid.uuid4())
    _sessions[session_token] = user
    log.info("Auth OK: %s", user["email"])

    return {"session_token": session_token, **user}


@app.get("/auth/session")
async def get_session(token: str = ""):
    """Returns user info for an existing session token."""
    user = _sessions.get(token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    return user


@app.post("/auth/logout")
async def logout(payload: dict):
    _sessions.pop(payload.get("session_token", ""), None)
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════════════════
# IN-MEMORY SCAN STORE
# ═══════════════════════════════════════════════════════════════════════════
import csv
import threading
from io import StringIO, BytesIO
from datetime import datetime, date
from fastapi.responses import StreamingResponse

_scan_lock  = threading.Lock()
_scan_store: list = []   # list[dict]  — newest first
MAX_SCANS   = 2000       # cap to prevent unbounded growth


def _append_scan(record: dict) -> None:
    with _scan_lock:
        _scan_store.insert(0, record)
        if len(_scan_store) > MAX_SCANS:
            del _scan_store[MAX_SCANS:]


@app.post("/report-scan")
async def report_scan(payload: dict):
    """
    Called by the frontend after every inspection to persist the result.
    Accepts a JSON body with: timestamp, product_type, status, confidence, reason
    """
    record = {
        "timestamp":          payload.get("timestamp", datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
        "product_type":       str(payload.get("product_type", "Unknown")),
        "status":             str(payload.get("status", "UNCERTAIN")),
        "confidence":         float(payload.get("confidence", 0.0)),
        "reason":             str(payload.get("reason") or payload.get("message") or ""),
        "scan_id":            str(payload.get("scanId") or payload.get("scan_id") or ""),
        "source":             str(payload.get("source", "camera")),
        "processing_time_ms": float(payload.get("processing_time_ms") or 0.0),
        "model_name":         str(payload.get("model_name") or "CV-Pipeline"),
    }
    _append_scan(record)
    return {"ok": True, "stored": len(_scan_store)}


@app.get("/scans")
async def get_scans(
    limit: int = 200,
    product: str = "",
    status: str = "",
    from_date: str = "",   # YYYY-MM-DD
    to_date: str = "",     # YYYY-MM-DD
):
    """Return filtered scans (newest first). Supports product, status, date range."""
    with _scan_lock:
        data = list(_scan_store)
    if product and product.lower() != "all":
        data = [s for s in data if s["product_type"].lower() == product.lower()]
    if status and status.lower() != "all":
        data = [s for s in data if s["status"].lower() == status.lower()]
    if from_date:
        try:
            fd = datetime.strptime(from_date, "%Y-%m-%d").date()
            data = [s for s in data if datetime.fromisoformat(s["timestamp"][:10]).date() >= fd]
        except Exception:
            pass
    if to_date:
        try:
            td = datetime.strptime(to_date, "%Y-%m-%d").date()
            data = [s for s in data if datetime.fromisoformat(s["timestamp"][:10]).date() <= td]
        except Exception:
            pass
    return data[:limit]


@app.get("/stats")
async def get_stats(product: str = "", status: str = ""):
    """Aggregated KPI stats, optionally filtered by product / status."""
    with _scan_lock:
        data = list(_scan_store)
    if product and product.lower() != "all":
        data = [s for s in data if s["product_type"].lower() == product.lower()]

    total     = len(data)
    pass_cnt  = sum(1 for s in data if s["status"] == "PASS")
    fail_cnt  = sum(1 for s in data if s["status"] == "FAIL")
    unc_cnt   = sum(1 for s in data if s["status"] == "UNCERTAIN")
    avg_conf  = (sum(s["confidence"] for s in data) / total) if total else 0.0

    # Defect rate & latency
    defect_rate    = round(fail_cnt / total * 100, 1) if total else 0.0
    latencies      = [s.get("processing_time_ms", 0.0) for s in data if s.get("processing_time_ms", 0) > 0]
    latency_avg_ms = round(sum(latencies) / len(latencies), 0) if latencies else 0.0

    # Throughput: scans in last 60 seconds
    now_ts = time.time()
    recent_60s = []
    for s in data:
        try:
            ts = datetime.fromisoformat(s["timestamp"].replace(" ", "T")).timestamp()
            if now_ts - ts <= 60:
                recent_60s.append(s)
        except Exception:
            pass
    throughput_per_min = len(recent_60s)

    # Per-product breakdown
    by_product: dict = {}
    for s in data:
        pt = s["product_type"]
        if pt not in by_product:
            by_product[pt] = {"total": 0, "pass": 0, "fail": 0, "uncertain": 0}
        by_product[pt]["total"] += 1
        by_product[pt][s["status"].lower()] += 1

    # Scans-over-time (last 50, grouped by minute)
    seen: dict = {}
    for s in reversed(data[-200:]):
        key = s["timestamp"][:16]   # "YYYY-MM-DD HH:MM"
        if key not in seen:
            seen[key] = {"time": key[-5:], "pass": 0, "fail": 0, "uncertain": 0, "total": 0}
        seen[key][s["status"].lower()] += 1
        seen[key]["total"] += 1
    timeline = list(seen.values())[-50:]

    # Sparkline: last 7 time buckets for mini KPI charts
    sparkline_buckets = list(seen.values())[-7:]
    sparkline = {
        "total": [b["total"] for b in sparkline_buckets],
        "pass":  [b["pass"]  for b in sparkline_buckets],
        "fail":  [b["fail"]  for b in sparkline_buckets],
    }
    # Pad to 7 if fewer data points
    for key_s in sparkline:
        while len(sparkline[key_s]) < 7:
            sparkline[key_s].insert(0, 0)

    return {
        "total":              total,
        "pass":               pass_cnt,
        "fail":               fail_cnt,
        "uncertain":          unc_cnt,
        "pass_rate":          round(pass_cnt / total * 100, 1) if total else 0.0,
        "fail_rate":          round(fail_cnt / total * 100, 1) if total else 0.0,
        "avg_conf":           round(avg_conf * 100, 1),
        "defect_rate":        defect_rate,
        "throughput_per_min": throughput_per_min,
        "latency_avg_ms":     latency_avg_ms,
        "sparkline":          sparkline,
        "by_product":         by_product,
        "timeline":           timeline,
    }


# ── CSV export (also aliased from old /report/download) ──────────────────────
def _build_csv_data(product: str = "", status: str = "",
                    from_date: str = "", to_date: str = "") -> str:
    """Filter scan store and return CSV string."""
    with _scan_lock:
        data = list(_scan_store)
    if product and product.lower() != "all":
        data = [s for s in data if s["product_type"].lower() == product.lower()]
    if status and status.lower() != "all":
        data = [s for s in data if s["status"].lower() == status.lower()]
    if from_date:
        try:
            fd = datetime.strptime(from_date, "%Y-%m-%d").date()
            data = [s for s in data if datetime.fromisoformat(s["timestamp"][:10]).date() >= fd]
        except Exception:
            pass
    if to_date:
        try:
            td = datetime.strptime(to_date, "%Y-%m-%d").date()
            data = [s for s in data if datetime.fromisoformat(s["timestamp"][:10]).date() <= td]
        except Exception:
            pass

    buf = StringIO()
    writer = csv.DictWriter(
        buf,
        fieldnames=["timestamp", "product_type", "status", "confidence", "reason", "scan_id", "source"],
        extrasaction="ignore",
    )
    writer.writeheader()
    for row in reversed(data):   # oldest first in CSV
        r = dict(row)
        r["confidence"] = f"{r.get('confidence', 0) * 100:.1f}%"
        writer.writerow(r)
    buf.seek(0)
    return buf.read()


@app.get("/report/csv")
@app.get("/report/download")  # backward-compat alias
async def download_report_csv(
    product: str = "", status: str = "",
    from_date: str = "", to_date: str = "",
):
    """Stream a filtered CSV of all stored scans."""
    try:
        content = _build_csv_data(product, status, from_date, to_date)
    except Exception:
        content = "timestamp,product_type,status,confidence,reason,scan_id,source\n"
    filename = f"smartedge_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        iter([content]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/report/pdf")
async def download_report_pdf(
    product: str = "", status: str = "",
    from_date: str = "", to_date: str = "",
):
    """Generate a professional PDF report using reportlab."""
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib import colors
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import cm
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
        )
        from reportlab.lib.enums import TA_CENTER, TA_LEFT

        # ── gather data ───────────────────────────────────────────────
        with _scan_lock:
            data = list(_scan_store)
        if product and product.lower() != "all":
            data = [s for s in data if s["product_type"].lower() == product.lower()]
        if status and status.lower() != "all":
            data = [s for s in data if s["status"].lower() == status.lower()]
        if from_date:
            try:
                fd = datetime.strptime(from_date, "%Y-%m-%d").date()
                data = [s for s in data if datetime.fromisoformat(s["timestamp"][:10]).date() >= fd]
            except Exception:
                pass
        if to_date:
            try:
                td = datetime.strptime(to_date, "%Y-%m-%d").date()
                data = [s for s in data if datetime.fromisoformat(s["timestamp"][:10]).date() <= td]
            except Exception:
                pass
        data = list(reversed(data))   # oldest first

        # ── compute stats ─────────────────────────────────────────────
        total    = len(data)
        pass_n   = sum(1 for s in data if s["status"] == "PASS")
        fail_n   = sum(1 for s in data if s["status"] == "FAIL")
        unc_n    = sum(1 for s in data if s["status"] == "UNCERTAIN")
        avg_conf = (sum(s.get("confidence", 0) for s in data) / total * 100) if total else 0
        pass_r   = round(pass_n / total * 100, 1) if total else 0
        fail_r   = round(fail_n / total * 100, 1) if total else 0

        # ── build PDF ─────────────────────────────────────────────────
        buf = BytesIO()
        doc = SimpleDocTemplate(
            buf, pagesize=A4,
            leftMargin=2*cm, rightMargin=2*cm,
            topMargin=2*cm, bottomMargin=2*cm,
        )
        styles   = getSampleStyleSheet()
        BLUE     = colors.HexColor("#2563eb")
        LGREY    = colors.HexColor("#f1f5f9")
        DGREY    = colors.HexColor("#475569")
        PASS_C   = colors.HexColor("#059669")
        FAIL_C   = colors.HexColor("#dc2626")
        UNC_C    = colors.HexColor("#d97706")

        h1 = ParagraphStyle("h1", fontSize=22, textColor=BLUE, spaceAfter=4,
                             fontName="Helvetica-Bold")
        h2 = ParagraphStyle("h2", fontSize=11, textColor=DGREY, spaceAfter=14,
                             fontName="Helvetica")
        sectionTitle = ParagraphStyle("sec", fontSize=10, textColor=BLUE,
                                      fontName="Helvetica-Bold", spaceBefore=14, spaceAfter=6)
        small = ParagraphStyle("small", fontSize=8, textColor=DGREY, fontName="Helvetica")

        story = []

        # ── Header block ──────────────────────────────────────────────
        story.append(Paragraph("SmartEdge AI Inspector", h1))
        subtitle_text = "Inspection Report"
        if product and product.lower() != "all":
            subtitle_text += f" · {product.upper()}"
        if from_date or to_date:
            date_range = f"{from_date or 'All time'} → {to_date or 'present'}"
            subtitle_text += f" · {date_range}"
        subtitle_text += f" · Generated {datetime.now().strftime('%Y-%m-%d %H:%M')}"
        story.append(Paragraph(subtitle_text, h2))
        story.append(HRFlowable(width="100%", thickness=2, color=BLUE, spaceAfter=16))

        # ── Summary KPI block ─────────────────────────────────────────
        story.append(Paragraph("Inspection Summary", sectionTitle))
        kpi_data = [
            ["Total Scans", "PASS", "FAIL", "UNCERTAIN", "Pass Rate", "Fail Rate", "Avg Confidence"],
            [
                str(total),
                str(pass_n), str(fail_n), str(unc_n),
                f"{pass_r}%", f"{fail_r}%",
                f"{avg_conf:.1f}%",
            ]
        ]
        kpi_tbl = Table(kpi_data, colWidths=[2.5*cm]*7)
        kpi_tbl.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0), (-1, 0), BLUE),
            ("TEXTCOLOR",     (0, 0), (-1, 0), colors.white),
            ("FONTNAME",      (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE",      (0, 0), (-1, -1), 8.5),
            ("ALIGN",         (0, 0), (-1, -1), "CENTER"),
            ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
            ("BACKGROUND",    (1, 1), (1, 1), colors.HexColor("#dcfce7")),   # pass green
            ("TEXTCOLOR",     (1, 1), (1, 1), colors.HexColor("#059669")),
            ("BACKGROUND",    (2, 1), (2, 1), colors.HexColor("#fee2e2")),   # fail red
            ("TEXTCOLOR",     (2, 1), (2, 1), colors.HexColor("#dc2626")),
            ("BACKGROUND",    (0, 1), (0, 1), LGREY),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [LGREY, colors.white]),
            ("GRID",          (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
            ("TOPPADDING",    (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ("FONTNAME",      (0, 1), (-1, 1), "Helvetica-Bold"),
        ]))
        story.append(kpi_tbl)
        story.append(Spacer(1, 20))

        # ── Scan records table ────────────────────────────────────────
        story.append(Paragraph(f"Scan Records ({total} inspections)", sectionTitle))
        hdr = ["#", "Timestamp", "Product", "Status", "Confidence", "Source", "Notes"]
        rows = [hdr]
        for i, s in enumerate(data[:200], 1):  # cap at 200 rows in PDF
            conf_pct = f"{s.get('confidence', 0)*100:.0f}%"
            reason   = (s.get("reason") or "")[:50]
            source   = s.get("source", "camera").upper()
            rows.append([
                str(i),
                s.get("timestamp", "")[:16],
                s.get("product_type", ""),
                s.get("status", ""),
                conf_pct,
                source,
                reason,
            ])
        col_widths = [0.7*cm, 3.4*cm, 2.2*cm, 2.0*cm, 1.8*cm, 1.8*cm, None]
        tbl = Table(rows, colWidths=col_widths, repeatRows=1)
        status_col = 3
        source_col = 5
        style_cmds = [
            ("BACKGROUND",     (0, 0), (-1, 0), BLUE),
            ("TEXTCOLOR",      (0, 0), (-1, 0), colors.white),
            ("FONTNAME",       (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE",       (0, 0), (-1, -1), 7),
            ("ALIGN",          (0, 0), (-1, -1), "LEFT"),
            ("ALIGN",          (0, 0), (0, -1), "CENTER"),
            ("ALIGN",          (status_col, 0), (status_col, -1), "CENTER"),
            ("ALIGN",          (4, 0), (4, -1), "RIGHT"),  # confidence right-align
            ("VALIGN",         (0, 0), (-1, -1), "MIDDLE"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [LGREY, colors.white]),
            ("GRID",           (0, 0), (-1, -1), 0.3, colors.HexColor("#e2e8f0")),
            ("TOPPADDING",     (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING",  (0, 0), (-1, -1), 4),
            ("LEFTPADDING",    (0, 0), (-1, -1), 4),
            ("RIGHTPADDING",   (0, 0), (-1, -1), 4),
        ]
        for ri, row in enumerate(rows[1:], 1):
            st = row[status_col]
            c  = PASS_C if st == "PASS" else FAIL_C if st == "FAIL" else UNC_C
            style_cmds.append(("TEXTCOLOR", (status_col, ri), (status_col, ri), c))
            style_cmds.append(("FONTNAME",  (status_col, ri), (status_col, ri), "Helvetica-Bold"))
            # Source chip color
            if row[source_col] == "MOBILE":
                style_cmds.append(("TEXTCOLOR", (source_col, ri), (source_col, ri), BLUE))
        tbl.setStyle(TableStyle(style_cmds))
        story.append(tbl)

        # Footer
        story.append(Spacer(1, 20))
        story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#cbd5e1"), spaceAfter=8))
        story.append(Paragraph(
            f"SmartEdge AI Inspector  ·  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  ·  Confidential",
            small
        ))

        doc.build(story)
        buf.seek(0)
        filename = f"smartedge_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
        return StreamingResponse(
            iter([buf.read()]),
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    except ImportError:
        # reportlab not installed — return a plain text fallback
        content = _build_csv_data(product, status, from_date, to_date)
        filename = f"smartedge_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        return StreamingResponse(
            iter([content]),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}" (install reportlab for PDF)'},
        )
    except Exception as e:
        log.error(f"PDF generation failed: {e}")
        return JSONResponse(status_code=500, content={"error": "PDF generation failed"})


# ═══════════════════════════════════════════════════════════════════════════
# CHAT / ASSISTANT
# ═══════════════════════════════════════════════════════════════════════════

@app.post("/chat")
async def chat(payload: dict):
    """
    Inspection assistant powered by Gemini.
    Receives a question, builds a scan-data context, and returns a short answer.
    """
    question = str(payload.get("question", "")).strip()
    if not question:
        return {"answer": "Please ask me something about your inspections."}

    # ── Build scan context from the store ──────────────────────────────────
    with _scan_lock:
        recent = list(_scan_store[:20])        # newest-first, up to 20

    total      = len(_scan_store)
    pass_cnt   = sum(1 for s in _scan_store if s["status"] == "PASS")
    fail_cnt   = sum(1 for s in _scan_store if s["status"] == "FAIL")
    unc_cnt    = sum(1 for s in _scan_store if s["status"] == "UNCERTAIN")
    avg_conf   = (sum(s["confidence"] for s in _scan_store) / total * 100) if total else 0.0

    last_scan  = recent[0] if recent else None

    # Format last 5 scans as a readable list
    scan_lines = []
    for s in recent[:5]:
        scan_lines.append(
            f"  • [{s['timestamp']}] {s['product_type']} → {s['status']} "
            f"({s['confidence']*100:.0f}% conf) — {s['reason'][:80] if s['reason'] else 'no detail'}"
        )
    scan_summary = "\n".join(scan_lines) if scan_lines else "  No scans recorded yet."

    last_scan_text = (
        f"{last_scan['product_type']} at {last_scan['timestamp']}: "
        f"{last_scan['status']} ({last_scan['confidence']*100:.0f}% confidence). "
        f"Reason: {last_scan['reason'][:120] if last_scan['reason'] else 'none'}"
    ) if last_scan else "No scans yet."

    system_prompt = f"""You are SmartEdge AI, a concise inspection assistant for a manufacturing QA system.
Answer in 1–3 short sentences. Be direct, helpful, and human — avoid bullet lists unless asked.
If you lack data, say: "I don't have enough data for that yet."

=== CURRENT SYSTEM DATA ===
Total scans: {total}
PASS: {pass_cnt} | FAIL: {fail_cnt} | UNCERTAIN: {unc_cnt}
Average confidence: {avg_conf:.1f}%
Pass rate: {round(pass_cnt/total*100,1) if total else 0}%

Last scan: {last_scan_text}

Recent scans (newest first):
{scan_summary}
===========================

User question: {question}"""

    # ── Call Gemini (run in executor so we don't block the async event loop) ──
    try:
        from google import genai as _genai
        api_key = os.getenv("GEMINI_API_KEY", "")
        if not api_key:
            return {"answer": "Assistant unavailable — API key not configured."}

        client = _genai.Client(api_key=api_key)

        def _sync_gemini():
            return client.models.generate_content(
                model="gemini-2.0-flash",
                contents=system_prompt,
            )

        try:
            loop = asyncio.get_running_loop()
            response = await asyncio.wait_for(
                loop.run_in_executor(None, _sync_gemini),
                timeout=25.0,
            )
        except asyncio.TimeoutError:
            log.warning("[chat] Gemini call timed out")
            return {"answer": "The assistant took too long to respond. Please try again."}

        answer = (response.text or "").strip()
        if not answer:
            return {"answer": "I couldn't generate a response. Please try again."}
        log.info("[chat] answered (%d chars)", len(answer))
        return {"answer": answer}

    except Exception as e:
        err = str(e).lower()
        log.error("[chat] Gemini exception: %s", e, exc_info=True)
        if "quota" in err or "rate" in err or "resource exhausted" in err or "429" in err:
            return {"answer": "Gemini quota reached. Please wait a moment and try again."}
        if "api key" in err or "permission" in err or "403" in err or "invalid" in err:
            return {"answer": "Assistant unavailable — check your GEMINI_API_KEY in backend/.env."}
        return {"answer": f"Assistant error: {str(e)[:150]}"}



# ── ElevenLabs TTS proxy ──────────────────────────────────────────────────────
@app.post("/tts")
async def text_to_speech(payload: dict):
    """
    Proxy ElevenLabs TTS so the frontend never exposes the API key.
    Returns MP3 audio as a streaming response.
    """
    import httpx
    from fastapi.responses import StreamingResponse

    text = str(payload.get("text", "")).strip()
    if not text:
        raise HTTPException(status_code=400, detail="No text provided")

    # Truncate to avoid huge TTS bills
    if len(text) > 500:
        text = text[:500] + "…"

    api_key  = os.getenv("ELEVENLABS_API_KEY", "")
    voice_id = os.getenv("ELEVENLABS_VOICE_ID", "3jR9BuQAOPMWUjWpi0ll")

    if not api_key or api_key == "your_elevenlabs_api_key_here":
        raise HTTPException(status_code=503, detail="ElevenLabs API key not configured")

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    headers = {
        "xi-api-key": api_key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    body = {
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(url, json=body, headers=headers)
            if resp.status_code != 200:
                log.warning("[tts] ElevenLabs error %d: %s", resp.status_code, resp.text[:200])
                raise HTTPException(status_code=resp.status_code, detail="ElevenLabs TTS failed")
            audio_bytes = resp.content

        return StreamingResponse(
            io.BytesIO(audio_bytes),
            media_type="audio/mpeg",
            headers={"Cache-Control": "no-store"},
        )
    except httpx.RequestError as exc:
        log.warning("[tts] request error: %s", exc)
        raise HTTPException(status_code=502, detail="TTS network error")





@app.post("/predict")
async def predict(
    file: Optional[UploadFile] = File(None),
    files: Optional[List[UploadFile]] = File(None),
    product_type: str = Form("PCB")
):
    """
    Accepts image file(s) and product type, routes to the appropriate model, 
    and returns defect predictions with fail-safe logic.
    """
    uploaded_files = []
    if files:
        uploaded_files.extend(files)
    if file:
        uploaded_files.append(file)
        
    if not uploaded_files:
        raise HTTPException(status_code=400, detail="No file provided")
        
    # Validate file type
    for f in uploaded_files:
        if not f.content_type.startswith("image/"):
            raise HTTPException(status_code=400, detail="All files must be images.")
            
    try:
        best_score = -1
        best_image = None
        best_preprocessed = None
        last_q_status = None
        last_q_message = None
        
        for f in uploaded_files:
            # Read the image data efficiently
            image_data = await f.read()
            
            # Open the image using PIL
            try:
                image = Image.open(io.BytesIO(image_data))
                # Convert to RGB to handle alpha channels or greyscale gracefully
                if image.mode != 'RGB':
                    image = image.convert('RGB')
            except Exception:
                continue # Skip invalid images in the list
                
            # 1. Quality Assessment and Preprocessing
            is_valid, q_status, q_message, q_score, preprocessed_image = preprocessor.assess_and_preprocess(image, product_type)
            
            if q_score > best_score:
                best_score = q_score
                best_image = image
                best_preprocessed = preprocessed_image
                last_q_status = q_status
                last_q_message = q_message
                best_is_valid = is_valid
        
        if best_image is None:
            raise HTTPException(status_code=400, detail="Invalid image format. Could not decode image.")
            
        if not best_is_valid:
            print(f"Image rejected. Quality Score: {best_score}, Reason: {last_q_message}")
            return JSONResponse(content={
                "product_type": product_type,
                "status": last_q_status,
                "defects": [],
                "confidence": 0.0,
                "message": last_q_message,
                "quality_score": best_score
            })
            
        print(f"Image passed quality check. Quality Score: {best_score}")
        q_score = best_score
        preprocessed_image = best_preprocessed
            
        # Routing logic based on product_type
        if product_type.upper() == "PCB":
            result = pcb_service.predict(preprocessed_image)
        elif product_type.upper() == "AUTOMOTIVE":
            result = automotive_service.predict(preprocessed_image)
        elif product_type.upper() == "BISCUIT":
            result = parleg_service.predict(preprocessed_image)   # Parle-G rectangle detector
        else:
            # Invalid product type
            return JSONResponse(content={
                "product_type": product_type,
                "status": "UNCERTAIN",
                "defects": [],
                "confidence": 0.0,
                "message": f"Invalid product type. Input not suitable for selected inspection type.",
                "quality_score": q_score
            })
            
        # Append quality score to successful results
        result["quality_score"] = q_score

        # Optional: Add extra global FAIL-SAFE system checks if not fully handled in services
        # e.g., if a PCB image is passed to Automotive, confidence might be low
        if result.get("confidence", 0.0) < 0.5 and result.get("status") != "PASS":
            result["status"] = "UNCERTAIN"
            if "Input not suitable" not in result.get("message", ""):
                result["message"] = "Possible domain mismatch or low confidence. " + result.get("message", "")

        # Run decision engine (single-shot mode — no voting for batch /predict)
        result = decision_engine.apply(result, user_id="batch", use_voting=False)

        return JSONResponse(content=_safe_json(result))
        
    except HTTPException as he:
        # Re-raise HTTPExceptions as is
        raise he
    except Exception as e:
        # Catch unexpected errors to prevent server crash
        print(f"Server error: {str(e)}")
        return JSONResponse(content={
            "product_type": product_type,
            "status": "UNCERTAIN",
            "defects": [],
            "confidence": 0.0,
            "message": "Unable to confidently analyze"
        })


# ---------------------------------------------------------------------------
# Gemini Vision endpoint  (domain-aware, API-minimal)
# ---------------------------------------------------------------------------

@app.post("/gemini-predict")  # noqa: C901
async def gemini_predict(
    file: Optional[UploadFile] = File(None),
    files: Optional[List[UploadFile]] = File(None),
    product_type: str = Form("UNKNOWN"),
    user_id: str = Form("default"),
):
    """
    Real-time AI inspection with domain-first routing.

    Pipeline
    --------
    1. Select sharpest frame (quality scoring).
    2. Classify domain with pure-OpenCV heuristics (no API call).
    3a. domain == UNKNOWN        → return UNCERTAIN immediately.
    3b. confident domain detected → route to CV service (pcb/biscuit/automotive).
    3c. low-confidence domain    → fallthrough to Gemini Vision.

    Always returns valid JSON, never crashes.
    """
    _UNCERTAIN_RESPONSE = {
        "object": "unknown",
        "status": "UNCERTAIN",
        "confidence": 0.0,
        "cached": False,
        "skipped_api": False,
    }

    _t0 = time.perf_counter()

    try:
        # ── Rate limit ────────────────────────────────────────────────────
        if not _check_rate_limit(user_id):
            return JSONResponse(content={
                **_UNCERTAIN_RESPONSE,
                "product_type": product_type,
                "reason": "Too many requests — please wait a moment.",
                "quality_score": 0.0,
            })

        # ── Collect uploaded files ────────────────────────────────────────
        uploaded_files: List[UploadFile] = []
        if files:
            uploaded_files.extend(files)
        if file:
            uploaded_files.append(file)

        if not uploaded_files:
            return JSONResponse(content={
                **_UNCERTAIN_RESPONSE,
                "product_type": product_type,
                "reason": "No image file provided.",
                "quality_score": 0.0,
            })

        # ── Select sharpest frame ─────────────────────────────────────────
        best_score = -1.0
        best_image = None

        for f in uploaded_files:
            if not f.content_type or not f.content_type.startswith("image/"):
                log.warning("[gemini-predict] Skipping non-image: %s", f.content_type)
                continue
            raw = await f.read()
            if not _validate_file_size(raw, "gemini-predict"):
                return JSONResponse(content={
                    **_UNCERTAIN_RESPONSE,
                    "product_type": product_type,
                    "reason": "File too large — maximum 15 MB allowed.",
                    "quality_score": 0.0,
                })
            try:
                img = Image.open(io.BytesIO(raw))
                if img.mode != "RGB":
                    img = img.convert("RGB")
            except Exception:
                continue
            _, _, _, q_score, _ = preprocessor.assess_and_preprocess(img, product_type)
            if q_score > best_score:
                best_score = q_score
                best_image = img

        if best_image is None:
            return JSONResponse(content={
                **_UNCERTAIN_RESPONSE,
                "product_type": product_type,
                "reason": "Could not decode any uploaded image.",
                "quality_score": 0.0,
            })

        q_score_rounded = round(min(best_score, 1.0), 3)
        log.info("[gemini-predict] quality=%.3f product=%s user=%s", best_score, product_type, user_id)

        # ── Step 1: Domain classification (pure OpenCV, no API) ───────────
        domain_result = classify_domain(best_image)
        log.info(
            "[domain] detected=%s conf=%.2f confident=%s",
            domain_result.domain, domain_result.confidence, domain_result.confident
        )

        # ── Step 2: Unknown domain → UNCERTAIN ───────────────────────────
        if domain_result.domain == "UNKNOWN":
            return JSONResponse(content={
                **_UNCERTAIN_RESPONSE,
                "product_type": product_type,
                "reason": "Object not in supported categories (PCB, Biscuit, Automotive).",
                "quality_score": q_score_rounded,
            })

        detected_domain = domain_result.domain

        # ── Step 3a: Confident domain → timeout-wrapped CV service ────────
        if domain_result.confident:
            log.info("[gemini-predict] Confident domain=%s — routing to CV service.", detected_domain)

            if detected_domain == "PCB":
                cv_result = await _run_with_timeout(pcb_service.predict, best_image)
            elif detected_domain == "BISCUIT":
                cv_result = await _run_with_timeout(parleg_service.predict, best_image)
            else:
                cv_result = await _run_with_timeout(automotive_service.predict, best_image)

            if cv_result is None:  # timeout
                cv_result = {"status": "UNCERTAIN", "confidence": 0.0,
                             "message": "Analysis timed out — please retry.", "defects": []}

            _elapsed_ms = round((time.perf_counter() - _t0) * 1000, 1)
            result = {
                "product_type":        detected_domain,
                "object":              detected_domain.lower(),
                "status":              cv_result.get("status", "UNCERTAIN"),
                "confidence":          round(float(cv_result.get("confidence", 0.0)), 3),
                "reason":              cv_result.get("message", ""),
                "defects":             cv_result.get("defects", []),
                "annotated_image":     cv_result.get("annotated_image"),
                "cached":              False,
                "skipped_api":         True,
                "quality_score":       q_score_rounded,
                "domain_confidence":   domain_result.confidence,
                "processing_time_ms":  _elapsed_ms,
                "model_name":          "CV-Pipeline",
            }
            result = decision_engine.apply(result, user_id=user_id, use_voting=True)
            log.info("[gemini-predict] CV result: %s conf=%.3f elapsed=%sms", result.get("status"), result.get("confidence", 0), _elapsed_ms)
            return JSONResponse(content=_safe_json({k: v for k, v in result.items() if v is not None}))

        # ── Step 3b: Weak domain → timeout-wrapped Gemini ────────────────
        effective_type = detected_domain if domain_result.confidence >= 0.30 else product_type
        log.info("[gemini-predict] Low-conf domain=%s → Gemini with type=%s", detected_domain, effective_type)

        gemini_result = await _run_with_timeout(
            gemini_vision_service.analyze,
            image=best_image, product_type=effective_type, user_id=user_id,
        )
        if gemini_result is None:  # timeout
            return JSONResponse(content={
                **_UNCERTAIN_RESPONSE,
                "product_type": product_type,
                "reason": "Analysis timed out — please retry.",
                "quality_score": q_score_rounded,
            })

        _elapsed_ms = round((time.perf_counter() - _t0) * 1000, 1)
        gemini_result["product_type"]        = effective_type
        gemini_result["quality_score"]       = q_score_rounded
        gemini_result["domain_confidence"]   = domain_result.confidence
        gemini_result["processing_time_ms"]  = _elapsed_ms
        gemini_result["model_name"]          = "Gemini-Vision"
        gemini_result = decision_engine.apply(gemini_result, user_id=user_id, use_voting=True)
        log.info("[gemini-predict] Gemini result: %s elapsed=%sms", gemini_result.get("status"), _elapsed_ms)
        return JSONResponse(content=_safe_json(gemini_result))

    except Exception as exc:
        log.error("[gemini-predict] Unhandled error: %s", exc, exc_info=True)
        return JSONResponse(content={
            **_UNCERTAIN_RESPONSE,
            "product_type": product_type,
            "reason": "Low confidence — please adjust camera and retry.",
            "quality_score": 0.0,
        })



# ─── /predict-upload — single still image, same pipeline ──────────────────────
@app.post("/predict-upload")
async def predict_upload(
    file: UploadFile = File(...),
    product_type: str = Form("PCB"),
    user_id: str     = Form("upload_user"),
):
    """
    Upload-mode inspection endpoint.

    Identical domain→CV→Gemini pipeline as /gemini-predict but:
    - Single file only (no multi-frame best-of selection)
    - Voting disabled (one-shot result, not a live stream)
    - Quality gate lenient: very high-res images are fine, but tiny
      images (<100×100) are rejected with a friendly message.

    Always returns structured JSON — never raises an unhandled error.
    """
    _UNCERTAIN_RESP = {
        "object": "unknown",
        "status": "UNCERTAIN",
        "confidence": 0.0,
        "cached": False,
        "skipped_api": False,
    }

    _t_upload_start = time.perf_counter()

    try:
        # ── 1. Validate file type and read ────────────────────────────────
        if not file or not file.content_type or not file.content_type.startswith("image/"):
            return JSONResponse(status_code=400, content={
                **_UNCERTAIN_RESP,
                "product_type": product_type,
                "reason": "Unsupported file type — please upload a JPG or PNG image.",
            })

        raw = await file.read()
        if len(raw) == 0:
            return JSONResponse(status_code=400, content={
                **_UNCERTAIN_RESP,
                "product_type": product_type,
                "reason": "Uploaded file is empty.",
            })
        if not _validate_file_size(raw, "predict-upload"):
            return JSONResponse(status_code=400, content={
                **_UNCERTAIN_RESP,
                "product_type": product_type,
                "reason": "File too large — maximum 15 MB allowed.",
            })

        try:
            img = Image.open(io.BytesIO(raw))
            if img.mode != "RGB":
                img = img.convert("RGB")
        except Exception:
            return JSONResponse(status_code=400, content={
                **_UNCERTAIN_RESP,
                "product_type": product_type,
                "reason": "Could not decode image — file may be corrupt.",
            })

        # ── 2. Minimum resolution check ───────────────────────────────────
        w, h = img.size
        if w < 100 or h < 100:
            return JSONResponse(status_code=400, content={
                **_UNCERTAIN_RESP,
                "product_type": product_type,
                "reason": f"Image too small ({w}×{h}px). Minimum 100×100 required.",
            })

        # ── 3. Resize if very large ───────────────────────────────────────
        max_side = 1280
        if max(w, h) > max_side:
            scale = max_side / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

        # ── 4. Quality score ──────────────────────────────────────────────
        is_valid, _, _, q_score, _ = preprocessor.assess_and_preprocess(img, product_type)
        q_score_rounded = round(min(float(q_score) / 100.0, 1.0), 3)
        log.info("[predict-upload] %s  size=%dx%d  quality=%.3f  type=%s",
                 file.filename, w, h, q_score_rounded, product_type)

        # ── 5. Domain classification ──────────────────────────────────────
        domain_result = classify_domain(img)
        log.info("[upload/domain] detected=%s conf=%.2f confident=%s",
                 domain_result.domain, domain_result.confidence, domain_result.confident)

        if domain_result.domain == "UNKNOWN":
            return JSONResponse(content={
                **_UNCERTAIN_RESP,
                "product_type": product_type,
                "reason": "Object not in supported categories (PCB, Biscuit, Automotive).",
                "quality_score": q_score_rounded,
            })

        detected_domain = domain_result.domain

        # ── 6a. Confident domain → timeout-wrapped CV service ─────────────
        if domain_result.confident:
            log.info("[predict-upload] Confident domain=%s → CV service.", detected_domain)
            if detected_domain == "PCB":
                cv_result = await _run_with_timeout(pcb_service.predict, img)
            elif detected_domain == "BISCUIT":
                cv_result = await _run_with_timeout(parleg_service.predict, img)
            else:
                cv_result = await _run_with_timeout(automotive_service.predict, img)

            if cv_result is None:
                cv_result = {"status": "UNCERTAIN", "confidence": 0.0,
                             "message": "Analysis timed out — please retry.", "defects": []}

            _upload_elapsed_ms = round((time.perf_counter() - _t_upload_start) * 1000, 1)
            result = {
                "product_type":        detected_domain,
                "object":              detected_domain.lower(),
                "status":              cv_result.get("status", "UNCERTAIN"),
                "confidence":          round(float(cv_result.get("confidence", 0.0)), 3),
                "reason":              cv_result.get("message", ""),
                "defects":             cv_result.get("defects", []),
                "annotated_image":     cv_result.get("annotated_image"),
                "cached":              False,
                "skipped_api":         True,
                "quality_score":       q_score_rounded,
                "domain_confidence":   domain_result.confidence,
                "processing_time_ms":  _upload_elapsed_ms,
                "model_name":          "CV-Pipeline",
            }
            result = decision_engine.apply(result, user_id=user_id, use_voting=False)
            log.info("[predict-upload] CV result: %s elapsed=%sms", result.get("status"), _upload_elapsed_ms)
            return JSONResponse(content=_safe_json({k: v for k, v in result.items() if v is not None}))

        # ── 6b. Low-confidence domain → timeout-wrapped Gemini ────────────
        effective_type = detected_domain if domain_result.confidence >= 0.30 else product_type
        log.info("[predict-upload] Low-conf domain → Gemini with type=%s", effective_type)

        gemini_result = await _run_with_timeout(
            gemini_vision_service.analyze,
            image=img, product_type=effective_type, user_id=user_id,
        )
        if gemini_result is None:
            return JSONResponse(content={
                **_UNCERTAIN_RESP,
                "product_type": product_type,
                "reason": "Analysis timed out — please retry with a different image.",
                "quality_score": q_score_rounded,
            })

        _upload_elapsed_ms = round((time.perf_counter() - _t_upload_start) * 1000, 1)
        gemini_result["product_type"]        = effective_type
        gemini_result["quality_score"]       = q_score_rounded
        gemini_result["domain_confidence"]   = domain_result.confidence
        gemini_result["processing_time_ms"]  = _upload_elapsed_ms
        gemini_result["model_name"]          = "Gemini-Vision"
        gemini_result = decision_engine.apply(gemini_result, user_id=user_id, use_voting=False)
        log.info("[predict-upload] Gemini result: %s elapsed=%sms", gemini_result.get("status"), _upload_elapsed_ms)
        return JSONResponse(content=_safe_json(gemini_result))

    except Exception as exc:
        log.error("[predict-upload] Unhandled error: %s", exc, exc_info=True)
        return JSONResponse(content={
            **_UNCERTAIN_RESP,
            "product_type": product_type,
            "reason": "Unexpected error — please retry with a different image.",
            "quality_score": 0.0,
        })


# ═══════════════════════════════════════════════════════════════════════════
# MOBILE STREAMING  —  phone camera → laptop dashboard
# ═══════════════════════════════════════════════════════════════════════════
import base64
import secrets
from datetime import datetime

# In-memory session store  {sessionId: {result, ts, rate_last, product_type}}
_mobile_sessions: dict[str, dict] = {}
_MOBILE_SESSION_TTL = 300   # seconds — expire after 5 min of inactivity
MOBILE_RATE_SEC     = 2.5   # minimum gap between frames per session


def _mobile_cleanup():
    """Remove sessions idle for > TTL seconds."""
    now = time.time()
    dead = [sid for sid, s in _mobile_sessions.items()
            if now - s.get("ts", 0) > _MOBILE_SESSION_TTL]
    for sid in dead:
        del _mobile_sessions[sid]
        log.info("[mobile] session expired: %s", sid)


# ── POST /mobile-session/create ─────────────────────────────────────────────
class MobileSessionCreate(BaseModel):
    product_type: str = "PCB"

@app.post("/mobile-session/create")
async def mobile_session_create(payload: MobileSessionCreate):
    """Laptop calls this to create a new mobile session and receive a sessionId."""
    _mobile_cleanup()
    session_id = secrets.token_urlsafe(12)   # 12-byte → 16-char URL-safe string
    _mobile_sessions[session_id] = {
        "result":       None,
        "ts":           time.time(),
        "rate_last":    0.0,
        "product_type": payload.product_type,
        "frame_count":  0,
    }
    log.info("[mobile] session created: %s (product=%s)", session_id, payload.product_type)
    return {"session_id": session_id, "product_type": payload.product_type}


# ── GET /mobile-result/{session_id} ────────────────────────────────────────
@app.get("/mobile-result/{session_id}")
async def mobile_result(session_id: str):
    """Laptop polls this endpoint (every ~1.5 s) to get the latest analysis result."""
    session = _mobile_sessions.get(session_id)
    if session is None:
        return JSONResponse(status_code=404, content={"error": "session_not_found"})
    # Keep session alive as long as laptop is polling
    session["ts"] = time.time()
    return {
        "session_id":   session_id,
        "product_type": session["product_type"],
        "frame_count":  session["frame_count"],
        "connected":    session.get("connected", False),
        "result":       session["result"],       # None if no frame yet
    }


# ── POST /mobile-frame  ──────────────────────────────────────────────────────
class MobileFramePayload(BaseModel):
    session_id:   str
    image_base64: str
    product_type: str = ""   # optional override — use session default if empty

@app.post("/mobile-frame")
async def mobile_frame(payload: MobileFramePayload):
    """
    Mobile phone calls this every 2-3 seconds with a JPEG frame (base64).
    The frame is run through the exact same pipeline as /gemini-predict and
    the result is stored in the session for the laptop to poll.
    """
    session = _mobile_sessions.get(payload.session_id)
    if session is None:
        return JSONResponse(
            status_code=404,
            content={"error": "session_not_found",
                     "detail": "Session expired or invalid. Please re-scan the QR code."},
        )

    # ── Rate limit per session ───────────────────────────────────────────────
    now = time.time()
    if now - session["rate_last"] < MOBILE_RATE_SEC:
        return JSONResponse(content={
            "status":  "rate_limited",
            "message": "Too fast — wait a moment before sending the next frame.",
        })
    session["rate_last"] = now
    session["ts"]        = now   # keep alive

    # ── Determine product type ───────────────────────────────────────────────
    product_type = (payload.product_type or session["product_type"] or "PCB").upper()

    # ── Decode base64 image ──────────────────────────────────────────────────
    try:
        # Strip data URI prefix if present: "data:image/jpeg;base64,/9j/..."
        b64_data = payload.image_base64
        if "," in b64_data:
            b64_data = b64_data.split(",", 1)[1]
        raw = base64.b64decode(b64_data)
    except Exception:
        return JSONResponse(content={
            "status":  "error",
            "message": "Invalid image data — could not decode base64.",
        })

    # ── File size guard ──────────────────────────────────────────────────────
    if len(raw) > MAX_FILE_BYTES:
        return JSONResponse(content={
            "status":  "error",
            "message": f"Frame too large ({len(raw)//1024} KB). Max 15 MB.",
        })

    # ── Decode to PIL Image ──────────────────────────────────────────────────
    try:
        img = Image.open(io.BytesIO(raw))
        if img.mode != "RGB":
            img = img.convert("RGB")
    except Exception:
        return JSONResponse(content={
            "status":  "error",
            "message": "Could not decode image frame.",
        })

    # ── Run the same pipeline as /gemini-predict ─────────────────────────────
    try:
        _, _, _, q_score, _ = preprocessor.assess_and_preprocess(img, product_type)
        q_score_rounded = round(min(q_score, 1.0), 3)

        domain_result = classify_domain(img)
        log.info("[mobile:%s] domain=%s conf=%.2f quality=%.3f",
                 payload.session_id[:8], domain_result.domain,
                 domain_result.confidence, q_score_rounded)

        if domain_result.domain == "UNKNOWN":
            result = {
                "status":       "UNCERTAIN",
                "object":       "unknown",
                "confidence":   0.0,
                "reason":       "Object not in supported categories.",
                "quality_score": q_score_rounded,
                "product_type": product_type,
                "cached":       False,
                "skipped_api":  False,
            }
        elif domain_result.confident:
            if domain_result.domain == "PCB":
                cv_result = await _run_with_timeout(pcb_service.predict, img)
            elif domain_result.domain == "BISCUIT":
                cv_result = await _run_with_timeout(parleg_service.predict, img)
            else:
                cv_result = await _run_with_timeout(automotive_service.predict, img)

            if cv_result is None:
                cv_result = {"status": "UNCERTAIN", "confidence": 0.0,
                             "message": "Analysis timed out.", "defects": []}

            result = {
                "product_type":      domain_result.domain,
                "object":            domain_result.domain.lower(),
                "status":            cv_result.get("status", "UNCERTAIN"),
                "confidence":        round(float(cv_result.get("confidence", 0.0)), 3),
                "reason":            cv_result.get("message", ""),
                "defects":           cv_result.get("defects", []),
                "cached":            False,
                "skipped_api":       True,
                "quality_score":     q_score_rounded,
                "domain_confidence": domain_result.confidence,
            }
            result = decision_engine.apply(result, user_id=payload.session_id, use_voting=True)
        else:
            effective_type = (domain_result.domain
                              if domain_result.confidence >= 0.30 else product_type)
            gemini_result = await _run_with_timeout(
                gemini_vision_service.analyze,
                image=img, product_type=effective_type, user_id=payload.session_id,
            )
            if gemini_result is None:
                gemini_result = {
                    "status": "UNCERTAIN", "confidence": 0.0,
                    "reason": "Analysis timed out.", "object": effective_type.lower(),
                }
            gemini_result["product_type"]  = effective_type
            gemini_result["quality_score"] = q_score_rounded
            gemini_result = decision_engine.apply(
                gemini_result, user_id=payload.session_id, use_voting=True)
            result = gemini_result

        # Add timestamp for the UI
        result["timestamp"] = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

        # Store for laptop polling
        session["result"]      = _safe_json(result)
        session["frame_count"] = session.get("frame_count", 0) + 1
        session["connected"]   = True   # mark live for laptop UI

        # Also add to global scan store so Dashboard + Reports pick it up
        # MUST use _append_scan (insert at front) so Reports see it immediately
        _mobile_elapsed_ms = round(float(result.get("processing_time_ms") or 0.0), 1)
        _append_scan({
            "id":                 secrets.token_hex(6),
            "timestamp":          result["timestamp"],
            "product_type":       result.get("product_type", product_type),
            "status":             result.get("status", "UNCERTAIN"),
            "confidence":         float(result.get("confidence", 0.0)),
            "reason":             result.get("reason", ""),
            "source":             "mobile",
            "processing_time_ms": _mobile_elapsed_ms,
            "model_name":         result.get("model_name", "CV-Pipeline"),
        })

        log.info("[mobile:%s] frame=%d status=%s conf=%.2f",
                 payload.session_id[:8], session["frame_count"],
                 result.get("status"), result.get("confidence", 0))

        # Return full result so the phone can display confidence + reason
        return {
            "ok":         True,
            "frame":      session["frame_count"],
            "status":     result.get("status"),
            "confidence": result.get("confidence", 0.0),
            "reason":     result.get("reason", ""),
            "product":    result.get("product_type", product_type),
        }

    except Exception as exc:
        log.error("[mobile-frame] pipeline error: %s", exc, exc_info=True)
        return JSONResponse(content={
            "status":  "error",
            "message": "Pipeline error — please retry.",
        })


# ── GET /mobile-session/{session_id}/ping  ─────────────────────────────────
@app.get("/mobile-session/{session_id}/ping")
async def mobile_ping(session_id: str):
    """Mobile phone calls this to verify its session is still alive."""
    if session_id in _mobile_sessions:
        _mobile_sessions[session_id]["ts"] = time.time()
        return {"alive": True,
                "product_type": _mobile_sessions[session_id]["product_type"]}
    return JSONResponse(status_code=404, content={"alive": False})




