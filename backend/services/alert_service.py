"""
alert_service.py
────────────────
Real-time industrial email alert system for SmartEdge AI Inspector.

Logic:
  • Monitors last 20 seconds of scan events (per user).
  • If ≥ 5 scans are FAIL or UNCERTAIN in that window → sends email + PDF.
  • 60-second cooldown prevents duplicate alerts.

Dependencies:
  pip install reportlab   (smtplib / email.mime are stdlib)
"""

import io
import os
import time
import smtplib
import logging
import threading
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders

# ── Load .env so values are always fresh even if the module was imported early ─
try:
    from dotenv import load_dotenv
    load_dotenv(override=True)
except ImportError:
    pass  # dotenv not installed — rely on env being set before process start

log = logging.getLogger("smartedge.alert")

# ── Alert thresholds ─────────────────────────────────────────────────────────
ALERT_WINDOW_SEC  = 20   # rolling window in seconds
ALERT_THRESHOLD   = 5    # number of bad scans to trigger alert
ALERT_COOLDOWN    = 60   # seconds between alerts per user


def _smtp_cfg():
    """Read SMTP config fresh from env at call time (handles restarts & .env edits)."""
    return (
        os.getenv("SMTP_EMAIL", ""),
        os.getenv("SMTP_PASSWORD", ""),
        os.getenv("SMTP_HOST", "smtp.gmail.com"),
        int(os.getenv("SMTP_PORT", "587")),
    )

# Keep module-level aliases for backward compat (tests, force_alert, etc.)
SMTP_EMAIL    = property(lambda self: _smtp_cfg()[0])  # ignored — use _smtp_cfg()
SMTP_PASSWORD = ""
SMTP_HOST     = "smtp.gmail.com"
SMTP_PORT     = 587

# ── Per-user cooldown store ───────────────────────────────────────────────────
_cooldown: dict[str, float] = {}   # user_id → last alert unix timestamp
_cooldown_lock = threading.Lock()

# ── Alert history (most recent 50) ───────────────────────────────────────────
_alert_log: list[dict] = []
_alert_log_lock = threading.Lock()


# ═════════════════════════════════════════════════════════════════════════════
# PDF Report Generation
# ═════════════════════════════════════════════════════════════════════════════

def generate_pdf_report(scan_data: list[dict], product_type: str, triggered_at: str) -> bytes:
    """
    Build a professional PDF inspection report.
    Returns raw PDF bytes (to be attached to email).
    Falls back gracefully if reportlab is not installed.
    """
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib import colors
        from reportlab.lib.units import cm
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
        )
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.enums import TA_CENTER, TA_LEFT

        buf = io.BytesIO()
        doc = SimpleDocTemplate(
            buf, pagesize=A4,
            leftMargin=2*cm, rightMargin=2*cm,
            topMargin=2*cm, bottomMargin=2*cm,
        )

        styles = getSampleStyleSheet()
        DARK   = colors.HexColor("#0f172a")
        ACCENT = colors.HexColor("#ef4444")
        GREY   = colors.HexColor("#64748b")
        LIGHT  = colors.HexColor("#f8fafc")
        GREEN  = colors.HexColor("#22c55e")
        AMBER  = colors.HexColor("#f59e0b")

        title_style = ParagraphStyle(
            "Title", parent=styles["Normal"],
            fontSize=22, fontName="Helvetica-Bold",
            textColor=DARK, alignment=TA_LEFT, spaceAfter=4,
        )
        sub_style = ParagraphStyle(
            "Sub", parent=styles["Normal"],
            fontSize=10, fontName="Helvetica",
            textColor=GREY, alignment=TA_LEFT, spaceAfter=2,
        )
        section_style = ParagraphStyle(
            "Section", parent=styles["Normal"],
            fontSize=12, fontName="Helvetica-Bold",
            textColor=DARK, spaceBefore=14, spaceAfter=6,
        )
        body_style = ParagraphStyle(
            "Body", parent=styles["Normal"],
            fontSize=9, fontName="Helvetica",
            textColor=GREY, leading=14,
        )

        story = []

        # ── Header ────────────────────────────────────────────────────────
        story.append(Paragraph("SmartEdge AI Inspector", title_style))
        story.append(Paragraph("Quality Alert Report", sub_style))
        story.append(HRFlowable(width="100%", thickness=1, color=ACCENT, spaceAfter=14))

        # ── Alert Summary table ───────────────────────────────────────────
        fail_cnt = sum(1 for s in scan_data if s.get("status") == "FAIL")
        unc_cnt  = sum(1 for s in scan_data if s.get("status") == "UNCERTAIN")
        total    = len(scan_data)

        summary_data = [
            ["Field", "Value"],
            ["Report Generated",  triggered_at],
            ["Product Type",      product_type.upper()],
            ["Total Scans in Window", str(total)],
            ["FAIL Count",        str(fail_cnt)],
            ["UNCERTAIN Count",   str(unc_cnt)],
            ["Alert Threshold",   f"≥ {ALERT_THRESHOLD} in {ALERT_WINDOW_SEC}s"],
            ["System Mode",       "Live Monitoring Active"],
        ]

        summary_table = Table(summary_data, colWidths=[5.5*cm, 11*cm])
        summary_table.setStyle(TableStyle([
            ("BACKGROUND",  (0, 0), (-1, 0), ACCENT),
            ("TEXTCOLOR",   (0, 0), (-1, 0), colors.white),
            ("FONTNAME",    (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE",    (0, 0), (-1, 0), 9),
            ("FONTSIZE",    (0, 1), (-1, -1), 8.5),
            ("FONTNAME",    (0, 1), (-1, -1), "Helvetica"),
            ("BACKGROUND",  (0, 1), (-1, -1), LIGHT),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT]),
            ("TEXTCOLOR",   (0, 1), (0, -1), DARK),
            ("TEXTCOLOR",   (1, 1), (1, -1), GREY),
            ("GRID",        (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
            ("ROWHEIGHT",   (0, 0), (-1, -1), 18),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ]))
        story.append(summary_table)

        # ── Last scans detail ─────────────────────────────────────────────
        story.append(Spacer(1, 10))
        story.append(Paragraph("Last 5 Scan Results", section_style))

        last5 = scan_data[:5]
        scan_rows = [["#", "Timestamp", "Status", "Confidence", "Product", "Note"]]
        for i, s in enumerate(last5, 1):
            conf_pct = f"{round(float(s.get('confidence', 0)) * 100)}%"
            scan_rows.append([
                str(i),
                s.get("timestamp", "—")[-8:],
                s.get("status", "—"),
                conf_pct,
                s.get("product_type", "—"),
                (s.get("reason") or "")[:40],
            ])

        scan_table = Table(scan_rows, colWidths=[0.6*cm, 2.4*cm, 2*cm, 2.2*cm, 2.4*cm, 6.9*cm])
        scan_table.setStyle(TableStyle([
            ("BACKGROUND",  (0, 0), (-1, 0), colors.HexColor("#1e293b")),
            ("TEXTCOLOR",   (0, 0), (-1, 0), colors.white),
            ("FONTNAME",    (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE",    (0, 0), (-1, -1), 8),
            ("FONTNAME",    (0, 1), (-1, -1), "Helvetica"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT]),
            ("TEXTCOLOR",   (0, 1), (-1, -1), GREY),
            ("GRID",        (0, 0), (-1, -1), 0.3, colors.HexColor("#e2e8f0")),
            ("ROWHEIGHT",   (0, 0), (-1, -1), 16),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ]))

        # Color status cells
        status_col = 2
        status_colors = {"PASS": GREEN, "FAIL": ACCENT, "UNCERTAIN": AMBER}
        for row_i, row in enumerate(scan_rows[1:], 1):
            c = status_colors.get(row[status_col], GREY)
            scan_table.setStyle(TableStyle([("TEXTCOLOR", (status_col, row_i), (status_col, row_i), c)]))

        story.append(scan_table)

        # ── Recommendations ───────────────────────────────────────────────
        story.append(Spacer(1, 10))
        story.append(Paragraph("Recommended Actions", section_style))
        recommendations = [
            "• Immediately inspect the production line for material or equipment anomalies.",
            "• Verify lighting conditions and camera alignment.",
            "• Check material consistency and batch quality.",
            "• Review equipment calibration records.",
            "• Escalate to production supervisor if anomalies persist.",
        ]
        for r in recommendations:
            story.append(Paragraph(r, body_style))

        # ── Footer ────────────────────────────────────────────────────────
        story.append(Spacer(1, 20))
        story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#e2e8f0")))
        story.append(Spacer(1, 6))
        story.append(Paragraph(
            f"This report was generated automatically by SmartEdge AI Monitoring System · {triggered_at}",
            ParagraphStyle("footer", parent=styles["Normal"],
                           fontSize=7.5, fontName="Helvetica", textColor=GREY, alignment=TA_CENTER)
        ))

        doc.build(story)
        return buf.getvalue()

    except ImportError:
        log.warning("[alert] reportlab not installed — sending plain-text PDF fallback")
        # Minimal text-only fallback
        lines = [
            b"SmartEdge AI Inspector - Quality Alert Report\n",
            f"Generated: {triggered_at}\n".encode(),
            f"Product: {product_type}\n".encode(),
            f"Issues detected: {len(scan_data)}\n".encode(),
        ]
        return b"".join(lines)


# ═════════════════════════════════════════════════════════════════════════════
# Email Sending
# ═════════════════════════════════════════════════════════════════════════════

_HTML_TEMPLATE = """\
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
body {{ font-family: 'Segoe UI', Arial, sans-serif; background:#f8fafc; margin:0; padding:0; }}
.wrap {{ max-width:620px; margin:32px auto; background:#fff; border-radius:12px;
         border:1px solid #e2e8f0; overflow:hidden; }}
.header {{ background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);
           padding:32px 36px; }}
.header h1 {{ color:#fff; margin:0; font-size:22px; letter-spacing:-0.02em; }}
.header p  {{ color:#94a3b8; margin:6px 0 0; font-size:13px; }}
.badge {{ display:inline-block; background:#ef4444; color:#fff; border-radius:6px;
          padding:3px 10px; font-size:11px; font-weight:700; letter-spacing:.05em;
          margin-top:12px; }}
.body {{ padding:28px 36px; }}
.greeting {{ color:#0f172a; font-size:15px; margin:0 0 14px; }}
.intro {{ color:#475569; font-size:13.5px; line-height:1.7; margin:0 0 22px; }}
.section-title {{ font-size:11px; font-weight:700; color:#94a3b8; letter-spacing:.08em;
                  text-transform:uppercase; margin:0 0 10px; }}
.summary-box {{ background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px;
                padding:16px 20px; margin-bottom:22px; }}
.summary-row {{ display:flex; justify-content:space-between; padding:5px 0;
                border-bottom:1px solid #f1f5f9; font-size:13px; }}
.summary-row:last-child {{ border-bottom:none; }}
.summary-key {{ color:#64748b; }}
.summary-val {{ color:#0f172a; font-weight:600; }}
.alert-chip {{ background:#fef2f2; border:1px solid #fecaca; border-radius:6px;
               color:#dc2626; font-weight:700; padding:2px 8px; font-size:12px; }}
.actions {{ background:#fffbeb; border:1px solid #fcd34d; border-radius:10px;
            padding:16px 20px; margin-bottom:22px; }}
.actions ul {{ margin:6px 0 0; padding-left:18px; color:#78350f; font-size:13px; line-height:1.9; }}
.insight {{ background:#eff6ff; border:1px solid #bfdbfe; border-radius:10px;
            padding:14px 20px; margin-bottom:22px; color:#1e40af; font-size:13px; line-height:1.6; }}
.footer {{ background:#f8fafc; border-top:1px solid #e2e8f0; padding:18px 36px;
           font-size:11.5px; color:#94a3b8; text-align:center; line-height:1.6; }}
</style></head>
<body>
<div class="wrap">
  <div class="header">
    <h1>⚠ SmartEdge Alert</h1>
    <p>Critical Quality Deviation Detected</p>
    <span class="badge">AUTOMATED ALERT</span>
  </div>
  <div class="body">
    <p class="greeting">Dear Operator,</p>
    <p class="intro">
      This is an automated alert from <strong>SmartEdge AI Inspection System</strong>.<br>
      A critical pattern of defective or uncertain outputs has been detected in your
      inspection pipeline and requires immediate attention.
    </p>

    <div class="section-title">Alert Summary</div>
    <div class="summary-box">
      <div class="summary-row">
        <span class="summary-key">Total Issues Detected</span>
        <span class="summary-val"><span class="alert-chip">{issue_count} issues</span></span>
      </div>
      <div class="summary-row">
        <span class="summary-key">Detection Time</span>
        <span class="summary-val">{triggered_at}</span>
      </div>
      <div class="summary-row">
        <span class="summary-key">Product Type</span>
        <span class="summary-val">{product_type}</span>
      </div>
      <div class="summary-row">
        <span class="summary-key">Window Analysed</span>
        <span class="summary-val">Last {window_sec} seconds</span>
      </div>
      <div class="summary-row">
        <span class="summary-key">FAIL Count</span>
        <span class="summary-val" style="color:#ef4444">{fail_count}</span>
      </div>
      <div class="summary-row">
        <span class="summary-key">UNCERTAIN Count</span>
        <span class="summary-val" style="color:#f59e0b">{uncertain_count}</span>
      </div>
      <div class="summary-row">
        <span class="summary-key">System Mode</span>
        <span class="summary-val" style="color:#22c55e">Live Monitoring Active</span>
      </div>
    </div>

    <div class="section-title">Technical Insight</div>
    <div class="insight">
      The system has identified repeated anomalies indicating a potential deviation in
      production quality or inspection conditions. The AI pipeline flagged
      <strong>{issue_count} consecutive non-PASS scans</strong> within a
      <strong>{window_sec}-second window</strong>, exceeding the configured alert threshold.
    </div>

    <div class="section-title">Recommended Actions</div>
    <div class="actions">
      <ul>
        <li>Immediately inspect the production line for material or equipment anomalies.</li>
        <li>Verify lighting conditions and camera alignment.</li>
        <li>Check material consistency and batch quality.</li>
        <li>Review equipment calibration records.</li>
        <li>Escalate to production supervisor if anomalies persist.</li>
      </ul>
    </div>

    <p style="color:#64748b;font-size:13px;margin:0;">
      A detailed PDF inspection report has been attached for further analysis.
    </p>
  </div>
  <div class="footer">
    This alert is generated automatically to ensure proactive quality control.<br>
    <strong>SmartEdge AI Monitoring System</strong> &middot; Do not reply to this email.
  </div>
</div>
</body></html>
"""


def send_email_alert(user_email: str, scan_data: list[dict], product_type: str) -> bool:
    """
    Send a professional HTML email with a PDF report attachment.
    Returns True on success, False on failure.
    """
    smtp_email, smtp_password, smtp_host, smtp_port = _smtp_cfg()

    log.info("[alert] SMTP config: email=%s host=%s port=%s pwd_set=%s",
             smtp_email, smtp_host, smtp_port, bool(smtp_password))

    if not smtp_email or not smtp_password:
        log.warning("[alert] SMTP_EMAIL / SMTP_PASSWORD not configured in .env — skipping email")
        return False

    triggered_at = datetime.now().strftime("%d %b %Y, %H:%M:%S")
    fail_count   = sum(1 for s in scan_data if s.get("status") == "FAIL")
    unc_count    = sum(1 for s in scan_data if s.get("status") == "UNCERTAIN")
    issue_count  = fail_count + unc_count

    # ── Build email ───────────────────────────────────────────────────────────
    msg = MIMEMultipart("mixed")
    msg["Subject"] = "SmartEdge Alert: Critical Quality Deviation Detected"
    msg["From"]    = f"SmartEdge Monitoring <{smtp_email}>"
    msg["To"]      = user_email

    html_body = _HTML_TEMPLATE.format(
        issue_count=issue_count,
        triggered_at=triggered_at,
        product_type=product_type.upper(),
        window_sec=ALERT_WINDOW_SEC,
        fail_count=fail_count,
        uncertain_count=unc_count,
    )
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    # ── Attach PDF ────────────────────────────────────────────────────────────
    try:
        pdf_bytes = generate_pdf_report(scan_data, product_type, triggered_at)
        ts_tag    = datetime.now().strftime("%Y%m%d_%H%M%S")
        part      = MIMEBase("application", "octet-stream")
        part.set_payload(pdf_bytes)
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", "attachment",
                        filename=f"smartedge_report_{ts_tag}.pdf")
        msg.attach(part)
    except Exception as pdf_err:
        log.warning("[alert] PDF generation failed: %s", pdf_err)

    # ── Send via SMTP ─────────────────────────────────────────────────────────
    try:
        log.info("[alert] Connecting to SMTP %s:%s …", smtp_host, smtp_port)
        with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as server:
            server.set_debuglevel(0)
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(smtp_email, smtp_password)
            server.sendmail(smtp_email, user_email, msg.as_bytes())
        log.info("[alert] ✅ Email sent to %s (issues=%d)", user_email, issue_count)
        return True
    except smtplib.SMTPAuthenticationError as e:
        log.error("[alert] ❌ SMTP Authentication failed — wrong email/App Password: %s", e)
        return False
    except smtplib.SMTPException as e:
        log.error("[alert] ❌ SMTP error: %s", e)
        return False
    except Exception as e:
        log.error("[alert] ❌ Unexpected email error: %s", e)
        return False


# ═════════════════════════════════════════════════════════════════════════════
# Alert Checker  (called from _append_scan hook in main.py)
# ═════════════════════════════════════════════════════════════════════════════

def check_and_alert(
    scan_store: list,
    user_email: str,
    user_id: str = "default",
) -> dict | None:
    """
    Analyse the last ALERT_WINDOW_SEC seconds of scan_store (newest-first list).
    If ≥ ALERT_THRESHOLD FAIL/UNCERTAIN scans exist and cooldown has passed,
    fires the email in a background thread and returns an alert dict.
    Returns None if no alert was triggered.
    """
    now = time.time()

    # ── Cooldown check ────────────────────────────────────────────────────────
    with _cooldown_lock:
        last_alert = _cooldown.get(user_id, 0)
        if now - last_alert < ALERT_COOLDOWN:
            return None   # still in cooldown

    # ── Filter scans in window ────────────────────────────────────────────────
    cutoff = datetime.utcnow()
    window_scans = []
    for s in scan_store:   # newest-first
        try:
            ts = datetime.strptime(s["timestamp"], "%Y-%m-%d %H:%M:%S")
            age = (cutoff - ts).total_seconds()
            if age > ALERT_WINDOW_SEC:
                break   # list is newest-first — nothing older matters
        except Exception:
            continue
        window_scans.append(s)

    bad = [s for s in window_scans if s.get("status") in ("FAIL", "UNCERTAIN")]
    if len(bad) < ALERT_THRESHOLD:
        return None

    # ── Trigger alert ─────────────────────────────────────────────────────────
    with _cooldown_lock:
        _cooldown[user_id] = now   # set cooldown immediately

    product_type = bad[0].get("product_type", "Unknown")
    triggered_at = datetime.now().strftime("%d %b %Y, %H:%M:%S")
    alert_record = {
        "triggered_at": triggered_at,
        "user_email":   user_email,
        "product_type": product_type,
        "issue_count":  len(bad),
        "fail_count":   sum(1 for s in bad if s.get("status") == "FAIL"),
        "uncertain_count": sum(1 for s in bad if s.get("status") == "UNCERTAIN"),
        "email_sent":   False,
    }

    with _alert_log_lock:
        _alert_log.insert(0, alert_record)
        if len(_alert_log) > 50:
            del _alert_log[50:]

    log.warning("[alert] TRIGGERED for %s — %d issues in %ds window",
                user_id, len(bad), ALERT_WINDOW_SEC)

    # Send email in background so it never blocks the scan pipeline
    def _bg():
        ok = send_email_alert(user_email, bad, product_type)
        alert_record["email_sent"] = ok

    threading.Thread(target=_bg, daemon=True).start()
    return alert_record


def get_alert_log() -> list[dict]:
    """Return a copy of the recent alert history."""
    with _alert_log_lock:
        return list(_alert_log)


def force_alert(user_email: str, product_type: str = "PCB") -> dict:
    """
    Immediately inject a synthetic alert (for testing).
    Bypasses the scan window check and cooldown.
    """
    triggered_at = datetime.now().strftime("%d %b %Y, %H:%M:%S")
    alert_record = {
        "triggered_at":   triggered_at,
        "user_email":     user_email,
        "product_type":   product_type,
        "issue_count":    5,
        "fail_count":     4,
        "uncertain_count": 1,
        "email_sent":     False,
        "test":           True,
    }
    with _alert_log_lock:
        _alert_log.insert(0, alert_record)

    log.warning("[alert] TEST alert forced for %s", user_email)

    fake_scans = [
        {"status": "FAIL",      "confidence": 0.91, "product_type": product_type,
         "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "reason": "Test defect"},
    ] * 5

    def _bg():
        ok = send_email_alert(user_email, fake_scans, product_type)
        alert_record["email_sent"] = ok

    threading.Thread(target=_bg, daemon=True).start()
    return alert_record
