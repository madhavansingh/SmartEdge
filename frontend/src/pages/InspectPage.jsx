import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CheckCircle2, AlertTriangle, Activity, History, Clock,
  Fingerprint, Radio, ThumbsDown, Camera, X, Play, Square,
  Zap, HelpCircle, WifiOff, Upload, ImageIcon, Trash2, Smartphone, Cpu
} from 'lucide-react';
import { useSystem } from '../context/SystemContext';
import MobileQRPanel from '../components/MobileQRPanel';
import { speakText } from '../utils/elevenLabsTTS';
import './InspectPage.css';


// ─── Voice Feedback (ElevenLabs via /api/tts) ─────────────────────
const speak = (() => {
  let lastSpoken = '';
  return (status) => {
    const map = {
      PASS: 'No defect detected. Part passed inspection.',
      FAIL: 'Defect detected. Part failed inspection.',
      UNCERTAIN: 'Unable to determine. Manual review required.',
    };
    const text = map[status];
    if (!text || text === lastSpoken) return;
    lastSpoken = text;
    speakText(text);
    // reset so next different result speaks again
    setTimeout(() => { lastSpoken = ''; }, 5000);
  };
})();


// ─── Sharpness score (variance of pixel brightness) ───────────────
function sharpnessScore(canvas) {
  try {
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let sum = 0, sumSq = 0, n = 0;
    for (let i = 0; i < data.length; i += 16) {
      const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      sum += lum; sumSq += lum * lum; n++;
    }
    const mean = sum / n;
    return sumSq / n - mean * mean; // variance
  } catch (_) { return 0; }
}

const API_BASE        = '/api';  // Vite proxy → localhost:8000
const LIVE_INTERVAL   = 3000; // minimum ms between API calls
const MIN_SHARPNESS   = 50;   // skip blurry frames
const FRAME_DIFF_SKIP = 8;    // skip if avg pixel diff < this (identical frame)

// ─── Fast perceptual frame hash (8×8 thumbnail brightness) ────────
function frameHash(canvas) {
  try {
    const tmp = document.createElement('canvas');
    tmp.width = 8; tmp.height = 8;
    tmp.getContext('2d').drawImage(canvas, 0, 0, 8, 8);
    const d = tmp.getContext('2d').getImageData(0, 0, 8, 8).data;
    let hash = '';
    for (let i = 0; i < d.length; i += 4)
      hash += Math.round((d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114) / 16).toString(16);
    return hash;
  } catch (_) { return null; }
}

function hashDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff += Math.abs(parseInt(a[i], 16) - parseInt(b[i], 16));
  return diff / a.length; // avg diff per cell
}

const InspectPage = () => {
  const { addScan, currentBatchId, startBatch, endBatch, batches, isDemoMode } = useSystem();

  const [productType, setProductType]   = useState('PCB');
  const [isLive, setIsLive]             = useState(false);
  const [isCamActive, setIsCamActive]   = useState(false);
  const [stream, setStream]             = useState(null);
  const [result, setResult]             = useState(null);
  const [analyzing, setAnalyzing]       = useState(false);
  const [liveStatus, setLiveStatus]     = useState('idle');
  const [history, setHistory]           = useState([]);
  const [customBatch, setCustomBatch]   = useState('');

  // ── Mobile mode state ──────────────────────────────────────────────
  const [showMobilePanel, setShowMobilePanel] = useState(false);
  const [mobileConnected, setMobileConnected] = useState(false);

  // ── Upload mode state ─────────────────────────────────────────────
  const [inputTab, setInputTab]         = useState('camera');  // 'camera' | 'upload'
  const [uploadFile, setUploadFile]     = useState(null);      // File object
  const [uploadPreview, setUploadPreview] = useState(null);    // Object URL
  const [uploadError, setUploadError]   = useState('');
  const [isDragging, setIsDragging]     = useState(false);
  const fileInputRef                    = useRef(null);
  const resultRef                       = useRef(null);        // scroll target

  const videoRef         = useRef(null);
  const canvasRef        = useRef(null);
  const abortRef         = useRef(null);
  const busyRef          = useRef(false);   // isProcessing lock — skip frame if true
  const loopTimerRef     = useRef(null);    // setTimeout handle for self-scheduling loop
  const prevStatusRef    = useRef(null);    // last spoken status — prevents voice repetition
  const prevFrameHashRef = useRef(null);    // last frame hash — skip identical frames
  const lastRequestTime  = useRef(0);       // monotonic timestamp of last sent request

  const genId = () => 'SCN-' + Math.random().toString(36).substr(2,6).toUpperCase();
  const nowTime = () => new Date().toTimeString().slice(0,8);

  // ─── Camera ───────────────────────────────────────────────────────
  const startCamera = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }
      }).catch(() => navigator.mediaDevices.getUserMedia({ video: true }));
      setStream(s);
      setIsCamActive(true);
    } catch (e) {
      alert('Camera access denied. Please allow camera permissions.');
    }
  };

  const stopCamera = useCallback(() => {
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setStream(null);
    setIsCamActive(false);
    setIsLive(false);
  }, [stream]);

  useEffect(() => {
    if (isCamActive && videoRef.current && stream && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
    }
  });

  useEffect(() => () => { if (stream) stream.getTracks().forEach(t => t.stop()); }, [stream]);

  // ─── Capture + Analyse frame ──────────────────────────────────────
  // LOCK: busyRef.current acts as isProcessing flag.
  // If true, the entire function exits immediately — no request is sent.
  // Only after the response (or error) does the lock release.
  const captureAndAnalyse = useCallback(async () => {
    // ── Gate 1: Processing lock ──────────────────────────────────────
    if (busyRef.current) {
      setLiveStatus('scanning'); // still working on previous frame
      return;
    }

    // ── Gate 2: Minimum time gap (debounce) ─────────────────────────
    const now = Date.now();
    if (now - lastRequestTime.current < LIVE_INTERVAL) return;

    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    // Draw current frame into canvas — always at native resolution first
    // so sharpness scoring has accurate data, then we resize for the send.
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    // ── Gate 3: Blur / sharpness check ──────────────────────────────
    const sharpness = sharpnessScore(canvas);
    if (sharpness < MIN_SHARPNESS) {
      setLiveStatus('focusing');
      return;
    }

    // ── Gate 4: Frame similarity — skip if scene hasn't changed ─────
    const currentHash = frameHash(canvas);
    const diff = hashDiff(currentHash, prevFrameHashRef.current);
    if (diff < FRAME_DIFF_SKIP) {
      setLiveStatus('done'); // same frame, keep last result
      return;
    }
    prevFrameHashRef.current = currentHash;

    // ── All gates passed — acquire lock and send request ────────────
    busyRef.current       = true;
    lastRequestTime.current = Date.now();
    setLiveStatus('scanning');
    setAnalyzing(true);

    abortRef.current = new AbortController();

    // ── Resize to max 640px before encoding — keeps payload small ───
    const MAX_DIM = 640;
    let sendCanvas = canvas;
    if (canvas.width > MAX_DIM || canvas.height > MAX_DIM) {
      const scale     = MAX_DIM / Math.max(canvas.width, canvas.height);
      sendCanvas      = document.createElement('canvas');
      sendCanvas.width  = Math.round(canvas.width  * scale);
      sendCanvas.height = Math.round(canvas.height * scale);
      sendCanvas.getContext('2d').drawImage(canvas, 0, 0, sendCanvas.width, sendCanvas.height);
    }

    const blob = await new Promise(res => sendCanvas.toBlob(res, 'image/jpeg', 0.82));
    if (!blob) { busyRef.current = false; setAnalyzing(false); return; }


    const formData = new FormData();
    formData.append('file', new File([blob], 'frame.jpg', { type: 'image/jpeg' }));
    formData.append('product_type', productType);
    formData.append('user_id', 'live_user');

    try {
      const res  = await fetch(`${API_BASE}/gemini-predict`, {
        method: 'POST',
        body: formData,
        signal: abortRef.current.signal,
      });
      const data = await res.json();

      const newResult = {
        ...data,
        scanId: genId(),
        timestamp: nowTime(),
        productType,
        incorrect: false,
      };

      setResult(newResult);
      setHistory(p => [newResult, ...p].slice(0, 8));
      addScan(newResult);
      setLiveStatus('done');

      // Voice — only when result status changes
      if (newResult.status !== prevStatusRef.current) {
        speak(newResult.status);
        prevStatusRef.current = newResult.status;
      }
    } catch (e) {
      if (e.name !== 'AbortError') setLiveStatus('idle');
    } finally {
      setAnalyzing(false);
      busyRef.current = false; // ← release lock
    }
  }, [productType, addScan]);

  // ─── Live loop — self-scheduling setTimeout (NOT setInterval) ────
  // Using setTimeout instead of setInterval ensures we never queue a
  // second call while the first is still awaited. The next tick is only
  // scheduled AFTER the current one completes (via the finally block).
  useEffect(() => {
    if (!isLive || !isCamActive) {
      clearTimeout(loopTimerRef.current);
      if (!isLive) {
        setLiveStatus('idle');
        busyRef.current        = false;
        prevFrameHashRef.current = null; // reset frame cache on stop
      }
      return;
    }

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      await captureAndAnalyse();
      if (!cancelled) {
        // Schedule next tick only after current one finishes.
        // Always wait at least LIVE_INTERVAL from the last request timestamp
        // so rapid completions don't stack up calls.
        const elapsed = Date.now() - lastRequestTime.current;
        const delay   = Math.max(0, LIVE_INTERVAL - elapsed);
        loopTimerRef.current = setTimeout(tick, delay);
      }
    };

    tick();

    return () => {
      cancelled = true;
      clearTimeout(loopTimerRef.current);
    };
  }, [isLive, isCamActive, captureAndAnalyse]);

  // ─── Demo ─────────────────────────────────────────────────────────
  const runDemo = async () => {
    if (!currentBatchId) startBatch();
    const demos = [
      { status:'PASS', object:'pcb', confidence:0.92, reason:'No visible defects detected on the board.' },
      { status:'PASS', object:'pcb', confidence:0.88, reason:'Solder joints and traces appear intact.' },
      { status:'FAIL', object:'pcb', confidence:0.95, reason:'Short circuit pattern detected near pin 7.' },
    ];
    for (const d of demos) {
      setAnalyzing(true);
      await new Promise(r => setTimeout(r, 900));
      const r = { ...d, scanId: genId(), timestamp: nowTime(), productType, incorrect: false };
      setResult(r);
      setHistory(p => [r, ...p].slice(0, 8));
      addScan(r);
      speak(r.status);
      setAnalyzing(false);
      await new Promise(r => setTimeout(r, 1500));
    }
  };

  // ─── Upload helpers ───────────────────────────────────────────────
  const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  const applyUploadFile = (f) => {
    setUploadError('');
    if (!f) return;
    if (!ACCEPTED_TYPES.includes(f.type)) {
      setUploadError('Unsupported file — please use JPG or PNG.');
      return;
    }
    if (f.size > 12 * 1024 * 1024) {
      setUploadError('File too large (max 12 MB).');
      return;
    }
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
    setUploadFile(f);
    setUploadPreview(URL.createObjectURL(f));
    setResult(null);
  };

  const clearUpload = () => {
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
    setUploadFile(null);
    setUploadPreview(null);
    setUploadError('');
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const analyseUpload = async () => {
    if (!uploadFile || analyzing) return;
    setAnalyzing(true);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      formData.append('product_type', productType);
      formData.append('user_id', 'upload_user');

      const res  = await fetch(`${API_BASE}/predict-upload`, { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok) {
        setUploadError(data.reason || 'Upload failed — please try a different image.');
        return;
      }

      const newResult = {
        ...data,
        scanId: genId(),
        timestamp: nowTime(),
        productType,
        incorrect: false,
        source: 'upload',
      };
      setResult(newResult);
      setHistory(p => [newResult, ...p].slice(0, 8));
      addScan(newResult);
      speak(newResult.status);
      // Scroll to result panel
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 120);
    } catch (e) {
      setUploadError('Network error — is the backend running?');
    } finally {
      setAnalyzing(false);
    }
  };

  // Clean up object URL on unmount
  useEffect(() => () => { if (uploadPreview) URL.revokeObjectURL(uploadPreview); }, []);

  // ─── Status helpers ───────────────────────────────────────────────
  const statusClass = s => s === 'PASS' ? 'pass' : s === 'FAIL' ? 'fail' : 'uncertain';

  // Replace raw internal error strings with user-friendly copy
  const sanitiseReason = (raw, status) => {
    if (!raw) return status === 'UNCERTAIN' ? 'Low confidence — please adjust camera position' : '—';
    const lower = raw.toLowerCase();
    if (lower.includes('model call failed'))      return 'Low confidence — please adjust camera and retry';
    if (lower.includes('quota'))                  return 'AI service busy — please wait a moment';
    if (lower.includes('rate limit'))             return 'Too many requests — please slow down';
    if (lower.includes('resource exhausted'))     return 'AI service busy — please wait';
    if (lower.includes('api key not configured')) return 'Service not configured — contact support';
    if (lower.includes('internal error'))         return 'Temporary error — please retry';
    return raw;
  };

  return (
    <div className="ip-root">

      {/* ── Header ── */}
      <header className="ip-header">
        <div className="ip-header-left">
          <h1 className="ip-title">Inspect</h1>
          <span className="ip-subtitle">Real-time AI Vision Pipeline</span>
        </div>
        <div className="ip-header-right">
          {/* Product type */}
          <select className="ip-select text-mono" value={productType} onChange={e => setProductType(e.target.value)}>
            <option value="PCB">PCB</option>
            <option value="BISCUIT">BISCUIT</option>
            <option value="AUTOMOTIVE">AUTOMOTIVE</option>
          </select>

          {/* Batch */}
          {currentBatchId ? (
            <div className="ip-batch-info text-mono">
              <span className="ip-batch-id">BATCH: {currentBatchId}</span>
              {batches.find(b => b.id === currentBatchId) && (
                <span className="ip-batch-stats">
                  {batches.find(b => b.id === currentBatchId).totalScans} scans ·{' '}
                  {batches.find(b => b.id === currentBatchId).defects} defects
                </span>
              )}
              <button className="ip-btn ip-btn-sm text-mono" onClick={endBatch}>
                <Square size={12}/> END
              </button>
            </div>
          ) : (
            <div className="ip-batch-info">
              <input className="ip-input text-mono" placeholder="Batch ID" value={customBatch}
                onChange={e => setCustomBatch(e.target.value)} />
              <button className="ip-btn ip-btn-sm text-mono" onClick={() => { startBatch(customBatch.trim()||null); setCustomBatch(''); }}>
                <Play size={12}/> START
              </button>
            </div>
          )}

          {isDemoMode && (
            <button className="ip-btn ip-btn-demo text-mono" onClick={runDemo} disabled={isLive}>
              <Zap size={14}/> DEMO
            </button>
          )}

          {/* Mobile Mode */}
          <button
            className="ip-btn text-mono"
            onClick={() => setShowMobilePanel(p => !p)}
            style={{
              background: showMobilePanel || mobileConnected
                ? 'linear-gradient(135deg,#3b82f6,#6366f1)'
                : undefined,
              color: showMobilePanel || mobileConnected ? '#fff' : undefined,
              border: mobileConnected ? '1.5px solid #3b82f6' : undefined,
            }}
          >
            <Smartphone size={14}/>
            {mobileConnected ? '📡 MOBILE' : 'MOBILE'}
          </button>
        </div>
      </header>

      {/* ── Mobile QR Panel overlay ── */}
      <AnimatePresence>
        {showMobilePanel && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            style={{
              position: 'fixed',
              top: 72, right: 24,
              zIndex: 9999,
            }}
          >
            <MobileQRPanel
              productType={productType}
              onClose={() => setShowMobilePanel(false)}
              onResult={(r) => {
                setMobileConnected(true);
                const newResult = {
                  ...r,
                  scanId: 'MOB-' + Math.random().toString(36).substr(2,5).toUpperCase(),
                  timestamp: r.timestamp || new Date().toTimeString().slice(0,8),
                  productType: r.product_type || productType,
                  source: 'mobile',
                  incorrect: false,
                };
                setResult(newResult);
                setHistory(p => [newResult, ...p].slice(0, 8));
                addScan(newResult);
                speak(newResult.status);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>


      {/* ── Body ── */}
      <div className="ip-body">

        {/* ── Input Panel (Camera / Upload tabs) ── */}
        <div className="ip-cam-panel">

          {/* Tab strip */}
          <div className="ip-tab-strip">
            <button
              className={`ip-tab text-mono ${inputTab === 'camera' ? 'ip-tab-active' : ''}`}
              onClick={() => { setInputTab('camera'); }}
            >
              <Camera size={13}/> CAMERA
            </button>
            <button
              className={`ip-tab text-mono ${inputTab === 'upload' ? 'ip-tab-active' : ''}`}
              onClick={() => { setInputTab('upload'); if (isLive) setIsLive(false); }}
            >
              <Upload size={13}/> UPLOAD
            </button>
          </div>

          {/* ── Camera tab ── */}
          {inputTab === 'camera' && (
            <>
              <div className="ip-cam-header">
                <div className="ip-cam-label text-mono">
                  {isLive && <span className="ip-live-dot"></span>}
                  {isLive ? 'LIVE' : isCamActive ? 'CAMERA READY' : 'CAMERA OFF'}
                </div>
                <div className="ip-cam-actions">
                  {!isCamActive ? (
                    <button className="ip-btn text-mono" onClick={startCamera}>
                      <Camera size={14}/> ACTIVATE CAMERA
                    </button>
                  ) : (
                    <>
                      <button
                        className={`ip-btn ${isLive ? 'ip-btn-stop' : 'ip-btn-live'} text-mono`}
                        onClick={() => setIsLive(v => !v)}
                      >
                        <Radio size={14}/> {isLive ? 'STOP LIVE' : 'START LIVE'}
                      </button>
                      <button className="ip-btn ip-btn-sm text-mono" onClick={stopCamera}>
                        <X size={14}/>
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="ip-cam-viewport">
                {isCamActive ? (
                  <>
                    <video ref={videoRef} autoPlay playsInline muted className="ip-video" />
                    <canvas ref={canvasRef} style={{ display:'none' }} />
                    {isLive && (
                      <div className="ip-scan-overlay">
                        <div className="ip-corner ip-corner-tl"/>
                        <div className="ip-corner ip-corner-tr"/>
                        <div className="ip-corner ip-corner-bl"/>
                        <div className="ip-corner ip-corner-br"/>
                        {analyzing && <div className="ip-scan-line"/>}
                      </div>
                    )}
                    <div className="ip-cam-status-chip text-mono">
                      {liveStatus === 'focusing' && <><Activity size={12}/> STABILIZING</>}
                      {liveStatus === 'scanning' && <><Activity size={12}/> ANALYZING...</>}
                      {liveStatus === 'done'     && <><CheckCircle2 size={12}/> COMPLETE</>}
                      {liveStatus === 'idle'     && <><WifiOff size={12}/> STANDBY</>}
                    </div>
                    {!isLive && (
                      <div className="ip-hints text-mono">
                        <span>PLACE ITEM IN CENTER</span>
                        <span>ENSURE PROPER LIGHTING</span>
                        <span>HOLD STEADY</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="ip-cam-empty text-mono">
                    <Camera size={40} className="ip-cam-empty-icon"/>
                    <span>CAMERA NOT ACTIVE</span>
                    <span className="ip-cam-empty-sub">Activate camera to begin real-time inspection</span>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Upload tab ── */}
          {inputTab === 'upload' && (
            <div className="ip-upload-panel">

              {/* Drop zone */}
              <div
                className={`ip-dropzone${isDragging ? ' ip-dropzone-active' : ''}${uploadPreview ? ' ip-dropzone-has-file' : ''}`}
                onClick={() => !uploadPreview && fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={e => {
                  e.preventDefault();
                  setIsDragging(false);
                  applyUploadFile(e.dataTransfer.files[0]);
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  style={{ display: 'none' }}
                  onChange={e => applyUploadFile(e.target.files[0])}
                />

                {uploadPreview ? (
                  <img src={uploadPreview} alt="preview" className="ip-upload-preview" />
                ) : (
                  <div className="ip-dropzone-inner text-mono">
                    <ImageIcon size={38} className="ip-dropzone-icon"/>
                    <span className="ip-dropzone-title">DROP IMAGE HERE</span>
                    <span className="ip-dropzone-sub">or click to browse · JPG / PNG</span>
                  </div>
                )}

                {/* Scanning line reused on preview */}
                {analyzing && uploadPreview && <div className="ip-scan-line"/>}
              </div>

              {/* Error */}
              {uploadError && (
                <div className="ip-upload-error text-mono">
                  <AlertTriangle size={13}/> {uploadError}
                </div>
              )}

              {/* Actions */}
              <div className="ip-upload-actions">
                <button
                  className="ip-btn text-mono"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={13}/> {uploadFile ? 'CHANGE FILE' : 'SELECT FILE'}
                </button>
                <button
                  className="ip-btn ip-btn-live text-mono"
                  onClick={analyseUpload}
                  disabled={!uploadFile || analyzing}
                >
                  {analyzing
                    ? <><div className="ip-pulse-sm"/> ANALYZING...</>
                    : <><Activity size={13}/> ANALYZE IMAGE</>
                  }
                </button>
                {uploadFile && (
                  <button className="ip-btn ip-btn-sm text-mono" onClick={clearUpload}>
                    <Trash2 size={13}/>
                  </button>
                )}
              </div>

              {/* File info */}
              {uploadFile && (
                <div className="ip-upload-meta text-mono">
                  <span>{uploadFile.name}</span>
                  <span>{(uploadFile.size / 1024).toFixed(0)} KB</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Result + History Panel ── */}
        <div className="ip-data-panel">

          {/* Result */}
          <div className="ip-result-card">
            <div className="ip-result-card-header text-mono">
              INSPECTION RESULT
              {result && <span className={`ip-status-dot ${statusClass(result.status)}`}/>}
            </div>

            <AnimatePresence mode="wait">
              {analyzing && !result && (
                <motion.div key="loading" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="ip-loading text-mono">
                  <div className="ip-pulse"/>
                  <span>ANALYZING FRAME...</span>
                </motion.div>
              )}

              {!result && !analyzing && (
                <motion.div key="empty" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="ip-empty text-mono">
                  <Activity size={32} className="ip-empty-icon"/>
                  <span>AWAITING INPUT</span>
                  <span className="ip-empty-sub">
                    {inputTab === 'camera' ? 'Activate camera and start live mode' : 'Upload an image and press Analyze'}
                  </span>
                </motion.div>
              )}

              {result && (
                <motion.div key={result.scanId} initial={{opacity:0,y:16}} animate={{opacity:1,y:0}} exit={{opacity:0}} className="ip-result-body">

                  {/* Big status badge */}
                  <div className={`ip-badge ip-badge-${statusClass(result.status)}`}>
                    {result.status === 'PASS'      && <CheckCircle2 size={36}/>}
                    {result.status === 'FAIL'       && <AlertTriangle size={36}/>}
                    {result.status === 'UNCERTAIN'  && <HelpCircle size={36}/>}
                    <span className="ip-badge-label">{result.status}</span>
                  </div>

                  {/* Details grid */}
                  <div className="ip-details text-mono">
                    <div className="ip-detail-row">
                      <span className="ip-detail-label">OBJECT</span>
                      <span className="ip-detail-value">{result.object || result.productType || '—'}</span>
                    </div>
                    <div className="ip-detail-row">
                      <span className="ip-detail-label">CONFIDENCE</span>
                      <span className="ip-detail-value">
                        {result.confidence != null ? `${(result.confidence*100).toFixed(1)}%` : '—'}
                      </span>
                    </div>
                    {result.quality_score != null && (
                      <div className="ip-detail-row">
                        <span className="ip-detail-label">IMG QUALITY</span>
                        <span className="ip-detail-value">
                          {/* quality_score is 0-1 float; clamp to 100 max */}
                          {Math.min(100, Math.round((result.quality_score ?? 0) * 100))}/100
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Confidence bar */}
                  {result.confidence != null && (
                    <div className="ip-conf-bar-wrap">
                      <motion.div
                        className={`ip-conf-bar ip-conf-bar-${statusClass(result.status)}`}
                        initial={{width:0}}
                        animate={{width:`${result.confidence*100}%`}}
                        transition={{duration:0.8, ease:'easeOut'}}
                      />
                    </div>
                  )}

                  {/* Reason — sanitised, never shows raw internal errors */}
                  <div className={`ip-reason text-mono ip-reason-${statusClass(result.status)}`}>
                    {sanitiseReason(result.reason || result.message, result.status)}
                  </div>

                  {/* Meta */}
                  <div ref={resultRef} className="ip-meta text-mono">
                    <span><Fingerprint size={11}/> {result.scanId}</span>
                    <span><Clock size={11}/> {result.timestamp}</span>
                    {result.cached && <span>⚡ CACHED</span>}
                    {result.source === 'upload' && <span><Upload size={10}/> UPLOAD</span>}
                  </div>


                  {/* ─ System Diagnostics ─────────────────────── */}
                  {(result.processing_time_ms != null || result.model_name) && (
                    <div className="ip-diagnostics">
                      <div className="ip-diagnostics-header">
                        <Cpu size={11}/> SYSTEM DIAGNOSTICS
                      </div>
                      {result.processing_time_ms != null && (
                        <div className="ip-diagnostics-row">
                          <span className="ip-diag-label">LATENCY</span>
                          <span className={`ip-diag-value ${
                            result.processing_time_ms < 1000 ? 'ip-diag-value--good' :
                            result.processing_time_ms < 3000 ? 'ip-diag-value--warn' : 'ip-diag-value--bad'
                          }`}>
                            {result.processing_time_ms.toFixed(0)} ms
                          </span>
                        </div>
                      )}
                      {result.model_name && (
                        <div className="ip-diagnostics-row">
                          <span className="ip-diag-label">MODEL</span>
                          <span className="ip-diag-value">{result.model_name}</span>
                        </div>
                      )}
                      {result.source && (
                        <div className="ip-diagnostics-row">
                          <span className="ip-diag-label">SOURCE</span>
                          <span className="ip-diag-value">{result.source.toUpperCase()}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="ip-actions">
                    <button className="ip-btn ip-btn-sm text-mono" onClick={() => { setResult(null); prevStatusRef.current = null; }}>
                      CLEAR
                    </button>
                    <button className="ip-btn ip-btn-sm text-mono" onClick={() => {
                      setResult(p => ({...p, incorrect:true}));
                      setHistory(p => p.map(i => i.scanId===result.scanId ? {...i,incorrect:true} : i));
                    }} disabled={result.incorrect}>
                      <ThumbsDown size={12}/> {result.incorrect ? 'FLAGGED' : 'INCORRECT'}
                    </button>
                  </div>

                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* History */}
          <div className="ip-history">
            <div className="ip-history-header text-mono">
              <History size={14}/> SCAN HISTORY
            </div>
            <div className="ip-history-list">
              {history.length === 0 ? (
                <p className="ip-history-empty text-mono">No scans yet.</p>
              ) : (
                <AnimatePresence>
                  {history.map((item, i) => (
                    <motion.div key={item.scanId+i}
                      initial={{opacity:0,x:8}} animate={{opacity:1,x:0}}
                      className={`ip-hist-item ${statusClass(item.status)}`}
                    >
                      <div className="ip-hist-top text-mono">
                        <span className="ip-hist-id">{item.scanId}</span>
                        <span className="ip-hist-time">{item.timestamp}</span>
                      </div>
                      <div className="ip-hist-bottom text-mono">
                        <span className={`ip-hist-status ${statusClass(item.status)}`}>{item.status}</span>
                        <span className="ip-hist-obj">{item.object || item.productType}</span>
                        {item.incorrect && <span className="ip-hist-flag">FLAGGED</span>}
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InspectPage;
