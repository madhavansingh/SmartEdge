# SmartEdge AI Inspector

> **Production-grade, multi-domain AI quality inspection platform** — real-time defect detection across PCB, Automotive, and Biscuit manufacturing lines, powered by a hybrid CV + Gemini Vision pipeline with a full-featured React dashboard.

[![Python](https://img.shields.io/badge/Python-3.11+-3776ab?logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=black)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)](https://vitejs.dev)
[![PyTorch](https://img.shields.io/badge/PyTorch-2.0+-ee4c2c?logo=pytorch&logoColor=white)](https://pytorch.org)
[![Gemini](https://img.shields.io/badge/Gemini-2.0_Flash-4285f4?logo=google&logoColor=white)](https://ai.google.dev)
[![License](https://img.shields.io/badge/License-MIT-22c55e)](LICENSE)

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [AI Pipeline Deep Dive](#ai-pipeline-deep-dive)
- [API Reference](#api-reference)
- [Frontend Pages](#frontend-pages)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [PCB Defect Detection Module](#pcb-defect-detection-module)
- [Real-Time Alert System](#real-time-alert-system)
- [Performance](#performance)
- [Roadmap](#roadmap)

---

## Overview

SmartEdge AI Inspector is an end-to-end **industrial quality control SaaS platform** that enables manufacturers to detect product defects in real time using a camera feed — from a desktop webcam or a mobile device connected via QR code. The system classifies defects across three manufacturing domains:

| Domain | Model | Defect Classes |
|---|---|---|
| **PCB** | ResNet-18 (PyTorch, fine-tuned) | Open circuit, Short, Mousebite, Spur, Spurious copper, Pin-hole |
| **Automotive** | OpenCV heuristics + Gemini Vision | Cracks, surface damage, corrosion |
| **Biscuit / Food** | Parle-G contour detector + Gemini Vision | Breaks, shape anomalies, foreign objects |

Every scan result flows through a **multi-layer decision pipeline**: image quality assessment → OpenCV domain classification → domain-specific CV model → optional Gemini Vision fallback → majority-vote stabilisation → persistent scan store → real-time alert monitoring.

---

## Architecture

```
                        ┌─────────────────────────────────────────────────────────────┐
                        │                  FRONTEND (React 19 + Vite)                 │
                        │  Landing → Login → Dashboard → Inspect → Reports → Profile  │
                        │  Mobile Camera Page (QR-code linked, no auth required)      │
                        └──────────────────────┬──────────────────────────────────────┘
                                               │ REST / HTTP
                        ┌──────────────────────▼──────────────────────────────────────┐
                        │                FASTAPI BACKEND (Python)                     │
                        │                                                             │
                        │  /gemini-predict ──► Image Quality Scorer                   │
                        │                      │                                      │
                        │                      ▼                                      │
                        │              Domain Classifier (OpenCV)                     │
                        │           PCB ──────┬────── BISCUIT ──── AUTOMOTIVE         │
                        │                     │                                       │
                        │            confident?                                       │
                        │            YES → CV Service (ResNet/OpenCV)                 │
                        │            NO  → Gemini Vision (gemini-2.0-flash-lite)      │
                        │                     │                                       │
                        │              Decision Engine                                │
                        │         (confidence floor + majority vote)                  │
                        │                     │                                       │
                        │           Scan Store (in-memory, 2000 cap)                  │
                        │                     │                                       │
                        │         Alert Service (sliding-window monitor)              │
                        │         SMTP Email + PDF report on threshold breach         │
                        └─────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Domain-first routing**: A zero-API-cost OpenCV classifier runs first. Only if it's uncertain does the system call Gemini — minimising quota consumption.
- **Gemini key pool**: Up to 10 `GEMINI_API_KEY_N` keys auto-rotate on quota/rate errors, with per-key cooldowns and health tracking.
- **Majority voting**: Live-mode results are smoothed over a 3-frame window per `user_id` to eliminate single-frame false positives.
- **Never crashes**: Every endpoint returns a valid JSON response — even on model failure, timeout, or unhandled exceptions — returning `UNCERTAIN` with a human-readable reason.

---

## Features

### Core Inspection
- **Real-time live-mode** inspection via webcam at configurable intervals
- **Batch upload** of multiple images with best-frame selection by quality score
- **Mobile camera integration** — scan a QR code, open on phone, stream to desktop dashboard
- **Auto domain detection** — no manual product type selection needed in Gemini mode
- **3-frame majority voting** for stable live-mode output
- **Image quality assessment** — blur, brightness, and contrast scoring before AI inference

### Analytics & Reporting
- **Live KPI dashboard** — total scans, pass rate, fail rate, avg confidence, throughput/min, avg latency
- **Per-product breakdown** with sparkline mini-charts
- **Timeline chart** — scans grouped by minute, pass/fail/uncertain stacked
- **Filterable scan log** — by product, status, date range
- **CSV export** — one-click download, filterable
- **PDF report generation** — professional A4 layout via ReportLab with KPI table + scan records

### Alerting
- **Sliding-window alert engine** — triggers if ≥5 FAIL/UNCERTAIN scans appear within 20 seconds
- **HTML email alert** with styled template sent via SMTP (Gmail-compatible)
- **PDF attachment** automatically generated and attached to alert email
- **60-second per-user cooldown** to prevent alert spam
- **Alert history log** — last 50 alerts accessible via `/alert-status`
- **Force-alert endpoint** for integration testing

### Auth & UX
- **Google OAuth 2.0** sign-in (robust dual-strategy: `google-auth` library + tokeninfo URL fallback)
- **Session-token based auth** with in-memory session store
- **Protected routes** — dashboard, inspect, reports gated behind auth
- **AI Chat Assistant** — Gemini-powered Q&A with live scan context injected into prompt
- **ElevenLabs TTS proxy** — assistant answers read aloud (API key never exposed to browser)
- **Mobile-first QR flow** — `/mobile/:sessionId` page streams camera frames to the desktop session

---

## Tech Stack

### Backend
| Package | Role |
|---|---|
| `fastapi` + `uvicorn` | Async web framework & ASGI server |
| `torch` + `torchvision` | ResNet-18 PCB defect classifier |
| `opencv-python-headless` | Domain classifier, image preprocessing |
| `Pillow` (PIL) | Image I/O and manipulation |
| `google-generativeai` + `google-genai` | Gemini Vision & Chat |
| `google-auth` | Google ID token verification |
| `reportlab` | PDF report generation |
| `httpx` | Async ElevenLabs TTS proxy |
| `certifi` | macOS SSL certificate fix |
| `python-dotenv` | `.env` loading |

### Frontend
| Package | Role |
|---|---|
| `react` 19 | UI framework |
| `react-router-dom` 7 | Client-side routing |
| `vite` 8 | Dev server & bundler |
| `recharts` | Dashboard charts (line, bar, pie) |
| `framer-motion` | Page & component animations |
| `lucide-react` | Icon library |
| `qrcode` | Mobile QR code generation |

---

## Project Structure

```
Detection/
├── backend/
│   ├── main.py                    # FastAPI app — all routes (1747 lines)
│   ├── model_service.py           # Model loading utility
│   ├── requirements.txt
│   ├── .env.example
│   ├── models/
│   │   └── best_model.pth         # Fine-tuned ResNet-18 weights
│   ├── services/
│   │   ├── gemini_vision_service.py   # Singleton Gemini Vision client
│   │   ├── gemini_key_pool.py         # Multi-key pool with cooldowns
│   │   ├── domain_classifier.py       # Pure-OpenCV domain detector
│   │   ├── decision_engine.py         # Confidence floor + majority vote
│   │   ├── alert_service.py           # SMTP alerting + PDF generation
│   │   ├── pcb_service.py             # ResNet-18 PCB inference
│   │   ├── automotive_service.py      # Automotive CV inference
│   │   ├── biscuit_service.py         # Legacy biscuit service
│   │   └── parleg_service.py          # Parle-G contour detector
│   └── utils/
│       └── image_quality.py           # Blur/brightness/contrast scorer
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx                    # Router + provider tree
│   │   ├── design-system.css          # Full design token system
│   │   ├── context/
│   │   │   ├── AuthContext.jsx        # Google OAuth session state
│   │   │   ├── SystemContext.jsx      # Global scan/stats state
│   │   │   └── SettingsContext.jsx    # User preferences
│   │   ├── components/
│   │   │   ├── Layout.jsx             # Sidebar + top-bar shell
│   │   │   ├── ChatAssistant.jsx      # Floating AI chat widget
│   │   │   ├── MobileQRPanel.jsx      # QR code + mobile session
│   │   │   ├── ProtectedRoute.jsx     # Auth guard
│   │   │   └── SkeletonLoader.jsx     # Loading placeholders
│   │   └── pages/
│   │       ├── LandingPage.jsx        # Marketing / hero page
│   │       ├── LoginPage.jsx          # Google sign-in
│   │       ├── DashboardPage.jsx      # KPI + charts + alerts
│   │       ├── InspectPage.jsx        # Live camera inspection
│   │       ├── ReportsPage.jsx        # Scan log + export
│   │       ├── MobilePage.jsx         # Mobile camera stream
│   │       ├── ProfilePage.jsx
│   │       └── SettingsPage.jsx
│   ├── package.json
│   └── vite.config.js
│
├── pcb-defect-detection/          # Standalone ML research module
│   ├── notebooks/                 # EDA + training notebooks
│   ├── src/dataset_utils.py
│   ├── results/                   # Training curves, confusion matrices
│   └── README.md
│
├── Damaged-Car-parts-prediction-using-YOLOv8/  # YOLOv8 research module
│   ├── best.pt / best.onnx        # Trained YOLO weights
│   └── deployment.py
│
└── smoke_upload.py                # Integration smoke-test script
```

---

## AI Pipeline Deep Dive

### 1. Image Quality Assessment (`utils/image_quality.py`)
Every image is scored before model inference:
- **Blur** — Laplacian variance (low variance = blurry → reject)
- **Brightness** — mean pixel value (too dark / too bright → warn)
- **Contrast** — standard deviation of pixel values

Only the sharpest frame from a batch is forwarded to inference.

### 2. Domain Classifier (`services/domain_classifier.py`)
Pure OpenCV, **zero API cost**. Runs on every frame:

| Domain | Heuristic |
|---|---|
| PCB | Green hue fraction (H 35–85°) × 0.55 + Canny edge density × 0.45 |
| Biscuit | Warm-tone fraction (H 5–35°) × 0.60 + Largest-contour circularity × 0.40 |
| Automotive | Inverse mean saturation (metallic) × 0.55 + Contour fill fraction × 0.45 |

- Score ≥ 0.55 → **confident** → skip Gemini, route to CV service
- Score 0.30–0.55 → **weak match** → seed product hint, fallthrough to Gemini
- Score < 0.30 → **UNKNOWN** → return UNCERTAIN immediately

### 3. CV Services
**PCB Service** (`pcb_service.py`):
- ResNet-18 backbone, multi-label sigmoid head (6 classes)
- Defect threshold: 0.5 (confident FAIL) / 0.2–0.5 (UNCERTAIN)
- Runs on CUDA → MPS (Apple Silicon) → CPU

**Automotive Service** (`automotive_service.py`):
- OpenCV-based contour analysis + texture scoring

**Parle-G / Biscuit Service** (`parleg_service.py`):
- Shape-based contour detector for rectangular/circular food items

### 4. Gemini Vision Service (`services/gemini_vision_service.py`)
- Model: `gemini-2.0-flash-lite` (best free-tier rate limits)
- Image resized to max 1024px before API call
- **Image hash caching** (MD5, FIFO eviction at 128 entries) — identical frames skip API
- **Per-user rate limiting**: 3-second minimum gap
- **Key pool rotation**: cycles through all configured keys on quota error
- Lenient prompt design: prefers PASS over FAIL, requires unmistakable damage for FAIL
- Response validated: JSON parsed, fields normalised, confidence clamped to [0, 1]

### 5. Decision Engine (`services/decision_engine.py`)
Applied to every result before returning to client:
1. **Confidence floor**: PASS/FAIL below 0.25 confidence → downgraded to UNCERTAIN
2. **Canonical reasons**: raw service strings mapped to clean operator-facing copy
3. **Majority voting** (live mode): sliding 3-frame window per `user_id`; returns highest-confidence result for the majority status

---

## API Reference

### Auth
| Method | Endpoint | Description |
|---|---|---|
| POST | `/auth/google` | Verify Google ID token, create session |
| GET | `/auth/session?token=` | Validate existing session |
| POST | `/auth/logout` | Invalidate session |

### Inspection
| Method | Endpoint | Description |
|---|---|---|
| POST | `/predict` | Batch inspection — CV models only |
| POST | `/gemini-predict` | Domain-aware inspection — CV + Gemini fallback |

**`POST /gemini-predict`** form fields:
- `file` / `files` — image upload(s)
- `product_type` — `PCB` \| `BISCUIT` \| `AUTOMOTIVE` \| `UNKNOWN`
- `user_id` — for per-user rate limiting and voting state

**Response:**
```json
{
  "product_type": "PCB",
  "status": "FAIL",
  "confidence": 0.87,
  "reason": "Detected broken edge or damage",
  "object": "pcb",
  "cached": false,
  "skipped_api": false,
  "quality_score": 0.92,
  "processing_time_ms": 312,
  "vote_count": 2,
  "vote_window": 3
}
```

### Scan Store & Analytics
| Method | Endpoint | Description |
|---|---|---|
| POST | `/report-scan` | Persist a scan result |
| GET | `/scans` | Filtered scan list (limit, product, status, dates) |
| GET | `/stats` | Aggregated KPIs + timeline + sparklines |
| GET | `/report/csv` | Download filtered CSV |
| GET | `/report/pdf` | Download professional PDF report |

### Alerts
| Method | Endpoint | Description |
|---|---|---|
| GET | `/alert-status` | Recent alert log |
| POST | `/test-email` | Send a test SMTP alert |

### Assistant
| Method | Endpoint | Description |
|---|---|---|
| POST | `/chat` | Gemini chat with live scan context |
| POST | `/tts` | ElevenLabs TTS proxy (returns MP3) |

### Utility
| Method | Endpoint | Description |
|---|---|---|
| GET | `/` | Health check |
| GET | `/server-info` | Returns LAN IP for QR code generation |

---

## Frontend Pages

| Route | Page | Description |
|---|---|---|
| `/` | Landing | Marketing hero, feature highlights, CTA |
| `/login` | Login | Google One-Tap sign-in |
| `/dashboard` | Dashboard | KPI cards, timeline chart, alert banner |
| `/inspect` | Inspect | Live camera + batch upload, result card |
| `/reports` | Reports | Filterable scan log, CSV/PDF export |
| `/profile` | Profile | User info from Google session |
| `/settings` | Settings | SMTP config, thresholds, preferences |
| `/mobile/:sessionId` | Mobile | Full-screen camera stream (no auth) |

All protected routes use `<ProtectedRoute>` which reads from `AuthContext`. The `SystemContext` provides global scan state and polling. `SettingsContext` persists user preferences.

---

## Getting Started

### Prerequisites
- Python 3.11+
- Node.js 20+
- A [Gemini API key](https://aistudio.google.com/apikey) (free)
- A Google OAuth Client ID (for login)

### Backend Setup

```bash
# 1. Navigate to backend
cd backend

# 2. Create and activate a virtual environment
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Configure environment
cp .env.example .env
# Edit .env with your keys (see Environment Variables section)

# 5. Start the server
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The API will be available at `http://localhost:8000`.  
Interactive docs at `http://localhost:8000/docs`.

### Frontend Setup

```bash
# 1. Navigate to frontend
cd frontend

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Set VITE_API_URL=http://localhost:8000

# 4. Start dev server
npm run dev
```

The app will be available at `http://localhost:5173`.

### Running Both Together

```bash
# Terminal 1
cd backend && uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Terminal 2
cd frontend && npm run dev
```

---

## Environment Variables

### Backend (`backend/.env`)

```env
# ── Gemini API Keys (up to 10, pool auto-rotates on quota error) ─────────────
GEMINI_API_KEY_1=your_first_key_here
GEMINI_API_KEY_2=your_second_key_here
# GEMINI_API_KEY_3= ... up to GEMINI_API_KEY_10
GEMINI_API_KEY=   # legacy single-key fallback

# ── Google OAuth ──────────────────────────────────────────────────────────────
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret

# ── Session Security ──────────────────────────────────────────────────────────
JWT_SECRET=generate_with__openssl_rand_-base64_32

# ── SMTP Email Alerts ─────────────────────────────────────────────────────────
SMTP_EMAIL=your-gmail@gmail.com
SMTP_PASSWORD=your_gmail_app_password   # Use Gmail App Password, not account password
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587

# ── ElevenLabs TTS (optional) ─────────────────────────────────────────────────
ELEVENLABS_API_KEY=your_elevenlabs_key
ELEVENLABS_VOICE_ID=your_voice_id
```

**Setting up Gmail SMTP:**
1. Enable 2-Factor Authentication on your Google account
2. Go to Google Account → Security → App Passwords
3. Generate a new App Password for "Mail"
4. Use that 16-character password as `SMTP_PASSWORD`

### Frontend (`frontend/.env`)

```env
VITE_API_URL=http://localhost:8000
VITE_GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
```

---

## PCB Defect Detection Module

The `pcb-defect-detection/` directory is a standalone research module with full training pipeline.

### Model: ResNet-18 (Transfer Learning)
- **Dataset**: DeepPCB (1,500 annotated PCB image pairs)
- **Task**: Multi-label classification (6 simultaneous defect classes)
- **Architecture**: ImageNet-pretrained ResNet-18 + custom sigmoid head

### Performance
| Metric | Score | Industry Target |
|---|---|---|
| F1 Score | **91.2%** | 85–95% ✅ |
| Precision | 86.2% | >80% ✅ |
| Recall | **98.3%** | >95% ✅ |
| Inference time | 20 ms/image | <100 ms ✅ |

### Per-Class F1
| Defect | F1 | Severity |
|---|---|---|
| Open Circuit | 97.7% | Critical |
| Short Circuit | 87.7% | Critical |
| Mousebite | 90.5% | High |
| Spur | 85.3% | Medium |
| Spurious Copper | 95.7% | Medium |
| Pin-hole | 93.2% | High |

### Training Config
```python
optimizer   = Adam(lr=1e-3, weight_decay=1e-4)
loss        = BCELoss()                      # multi-label
scheduler   = ReduceLROnPlateau(patience=3)
epochs      = 20
batch_size  = 16
dropout     = 0.5
augmentation = [RandomFlip, RandomRotation(±15°), ColorJitter]
```

**Key design choice — high recall over precision:**  
A missed defect ships to a customer → >$1,000 field failure cost.  
A false alarm → 2 minutes of manual review → ~$2 cost.  
The system is deliberately tuned to favour recall.

---

## Real-Time Alert System

The alert system (`services/alert_service.py`) monitors a sliding window of recent scans and triggers when quality degrades.

### Trigger Logic
```
Window:    last 20 seconds of scans per user_id
Threshold: ≥ 5 FAIL or UNCERTAIN results
Cooldown:  60 seconds between alerts (per user)
```

### Alert Flow
```
Scan appended to store
       │
       ▼  (background thread, non-blocking)
check_and_alert()
       │
  In cooldown? → return None
       │
  Window scan count ≥ threshold?
       │
       ▼
  Set cooldown immediately
  Build alert_record → insert to alert_log
       │
       ▼  (daemon thread)
  generate_pdf_report()
  send_email_alert()  ← HTML template + PDF attachment
```

### Email Content
- Styled HTML email with alert summary table
- FAIL / UNCERTAIN counts, detection timestamp, product type
- 5 recommended operator actions
- Attached PDF report (generated via ReportLab)

### Testing Alerts
```bash
# Send test email to verify SMTP credentials
curl -X POST http://localhost:8000/test-email \
  -H "Content-Type: application/json" \
  -d '{"to": "your@email.com"}'
```

---

## Performance

| Metric | Value |
|---|---|
| Max file size | 15 MB |
| Rate limit (per user) | 1 req / 2 s (global), 1 req / 3 s (Gemini) |
| Scan store capacity | 2,000 records (FIFO) |
| Gemini image cache | 128 entries (MD5 hash keyed) |
| Majority vote window | 3 frames |
| AI timeout | 28 seconds |
| Alert window | 20 seconds |
| Alert cooldown | 60 seconds |
| Supported image types | JPEG, PNG, WebP, BMP |
| Gemini model | `gemini-2.0-flash-lite` |
| Chat model | `gemini-2.0-flash` |

---

## Roadmap

- [ ] **WebSocket live feed** — push scan results to dashboard in real time without polling
- [ ] **YOLOv8 integration** — bounding-box defect localisation for PCB and automotive
- [ ] **Persistent database** — PostgreSQL/SQLite scan history across server restarts
- [ ] **Multi-tenant auth** — organisation-level isolation with role-based access
- [ ] **GradCAM visualisation** — highlight detected defect regions in the UI
- [ ] **ONNX/TensorRT export** — edge deployment for offline factory environments
- [ ] **Active learning loop** — flag uncertain predictions for human labelling, retrain
- [ ] **Webhook support** — POST scan events to external MES/ERP systems

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit changes: `git commit -m 'Add your feature'`
4. Push: `git push origin feature/your-feature`
5. Open a Pull Request

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

<div align="center">

**Built for production. Designed for operators. Powered by AI.**

*SmartEdge AI Inspector — Where computer vision meets the factory floor.*

</div>
