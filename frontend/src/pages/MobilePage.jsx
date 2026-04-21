import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';

// ── API routing ───────────────────────────────────────────────────────────────
// All requests go through Vite's dev-server proxy: /api/* → localhost:8000
const API_BASE = '/api';
const CAPTURE_INTERVAL_MS = 3000;
const MAX_DIM = 640;

// ── Colours ──────────────────────────────────────────────────────────────────
const STATUS_STYLE = {
  PASS:      { bg: '#d1fae5', text: '#065f46', border: '#6ee7b7', icon: '✅' },
  FAIL:      { bg: '#fee2e2', text: '#991b1b', border: '#fca5a5', icon: '❌' },
  UNCERTAIN: { bg: '#fef9c3', text: '#78350f', border: '#fde68a', icon: '⚠️' },
  default:   { bg: '#f1f5f9', text: '#475569', border: '#cbd5e1', icon: '📷' },
};

// ── Classify getUserMedia errors into human-readable messages ─────────────────
function parseCameraError(err) {
  if (!window.isSecureContext) {
    return {
      type: 'insecure',
      title: 'Secure connection required',
      msg: 'Camera access requires HTTPS. Open this page over HTTPS, or in Chrome go to:\nSettings → Privacy & Security → Site Settings → Insecure content → Allow.',
    };
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return {
      type: 'unavailable',
      title: 'Camera API unavailable',
      msg: 'Your browser does not support camera access on this connection. Try Chrome on Android over HTTPS.',
    };
  }
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return {
      type: 'denied',
      title: 'Camera permission denied',
      msg: 'You blocked camera access. Tap the lock icon in your browser address bar → Site permissions → Camera → Allow, then retry.',
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      type: 'notfound',
      title: 'No camera found',
      msg: 'No camera was detected on this device. Make sure a camera is connected and not in use by another app.',
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return {
      type: 'busy',
      title: 'Camera is busy',
      msg: 'Another app is using the camera. Close other apps or tabs using the camera, then retry.',
    };
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return {
      type: 'constraints',
      title: 'Camera settings not supported',
      msg: 'Your camera does not support the requested settings. Retrying with basic settings…',
    };
  }
  if (name === 'SecurityError') {
    return {
      type: 'insecure',
      title: 'Security error',
      msg: 'Camera blocked by browser security policy. This page must be served over HTTPS.',
    };
  }
  return {
    type: 'unknown',
    title: 'Camera error',
    msg: `${name ? name + ': ' : ''}${err?.message || 'Unknown error. Please try a different browser.'}`,
  };
}

export default function MobilePage() {
  const { sessionId } = useParams();

  const videoRef   = useRef(null);
  const canvasRef  = useRef(null);
  const busyRef    = useRef(false);
  const timerRef   = useRef(null);
  const streamRef  = useRef(null);

  const [camActive, setCamActive]     = useState(false);
  const [status, setStatus]           = useState('idle');   // idle | ready | scanning | done | error | expired
  const [lastResult, setLastResult]   = useState(null);
  const [frameCount, setFrameCount]   = useState(0);
  const [sessionOk, setSessionOk]     = useState(true);
  const [productType, setProductType] = useState('PCB');
  const [camError, setCamError]       = useState(null);     // { type, title, msg } | null

  // ── Verify session on mount ────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) { setSessionOk(false); return; }
    fetch(`${API_BASE}/mobile-session/${sessionId}/ping`)
      .then(r => r.json())
      .then(d => {
        if (!d.alive) { setSessionOk(false); setStatus('expired'); }
        else { setProductType(d.product_type || 'PCB'); }
      })
      .catch(() => setSessionOk(false));
  }, [sessionId]);

  // ── Start camera ───────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    setCamError(null);

    // 1. Secure context check (http:// on a non-localhost origin blocks getUserMedia)
    if (!window.isSecureContext) {
      setCamError(parseCameraError(null));   // insecure path
      setStatus('error');
      return;
    }

    // 2. API availability check
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamError({
        type: 'unavailable',
        title: 'Camera API unavailable',
        msg: 'Your browser does not support camera access. Please use Chrome on Android.',
      });
      setStatus('error');
      return;
    }

    // 3. Try with ideal rear-camera constraints first
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
    } catch (firstErr) {
      const parsed = parseCameraError(firstErr);

      // 4. If constraints were too tight, retry with bare minimum
      if (parsed.type === 'constraints') {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } catch (retryErr) {
          setCamError(parseCameraError(retryErr));
          setStatus('error');
          return;
        }
      } else {
        setCamError(parsed);
        setStatus('error');
        return;
      }
    }

    // 5. Attach stream
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      try { await videoRef.current.play(); } catch { /* autoplay policy — playsInline handles it */ }
    }
    setCamActive(true);
    setStatus('ready');
  }, []);

  const stopCamera = useCallback(() => {
    clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamActive(false);
    setCamError(null);
    setStatus('idle');
  }, []);

  // ── Capture + send frame ───────────────────────────────────────────────────
  const captureAndSend = useCallback(async () => {
    if (busyRef.current || !videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    if (video.readyState < 2) return;

    busyRef.current = true;
    setStatus('scanning');

    try {
      const canvas = canvasRef.current;
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);

      let sendCanvas = canvas;
      if (canvas.width > MAX_DIM || canvas.height > MAX_DIM) {
        const scale   = MAX_DIM / Math.max(canvas.width, canvas.height);
        sendCanvas    = document.createElement('canvas');
        sendCanvas.width  = Math.round(canvas.width  * scale);
        sendCanvas.height = Math.round(canvas.height * scale);
        sendCanvas.getContext('2d').drawImage(canvas, 0, 0, sendCanvas.width, sendCanvas.height);
      }

      const dataUrl = sendCanvas.toDataURL('image/jpeg', 0.82);

      const res = await fetch(`${API_BASE}/mobile-frame`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, image_base64: dataUrl, product_type: productType }),
      });

      const data = await res.json();

      if (res.status === 404) {
        setSessionOk(false);
        setStatus('expired');
        stopCamera();
        return;
      }

      if (data.ok) {
        setLastResult({
          status:     data.status,
          confidence: data.confidence ?? 0,
          reason:     data.reason   || '',
          product:    data.product  || productType,
        });
        setFrameCount(data.frame || 0);
        setStatus('done');
      } else if (data.status === 'rate_limited') {
        setStatus('ready');
      } else {
        setStatus('ready');
      }
    } catch {
      setStatus('ready');
    } finally {
      busyRef.current = false;
    }
  }, [sessionId, productType, stopCamera]);

  // ── Auto-capture loop ──────────────────────────────────────────────────────
  useEffect(() => {
    if (camActive) {
      timerRef.current = setInterval(captureAndSend, CAPTURE_INTERVAL_MS);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [camActive, captureAndSend]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => () => stopCamera(), [stopCamera]);

  // ── Status label ──────────────────────────────────────────────────────────
  const statusLabel = {
    idle:     'Tap Start to begin scanning',
    ready:    'Camera ready — scanning every 3s',
    scanning: 'Analyzing frame…',
    done:     `Sent frame #${frameCount}`,
    error:    camError?.title || 'Camera error',
    expired:  'Session expired — please re-scan the QR code on your laptop',
  }[status] || '';

  const resultStyle = lastResult
    ? (STATUS_STYLE[lastResult.status] || STATUS_STYLE.default)
    : STATUS_STYLE.default;

  // ── Debug info (dev only — shown when camera errors occur) ────────────────
  const isSecure = window.isSecureContext;
  const showDebug = status === 'error' && camError;

  return (
    <div style={{
      minHeight: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      background: '#0f172a',
      fontFamily: "'Inter', system-ui, sans-serif",
      color: '#f1f5f9',
      userSelect: 'none',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px 20px',
        background: 'rgba(255,255,255,0.05)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}>
        <div style={{
          width: 36, height: 36,
          background: 'linear-gradient(135deg,#3b82f6,#6366f1)',
          borderRadius: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18,
        }}>📡</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.01em' }}>
            SmartEdge Mobile
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>
            Session: {sessionId?.slice(0, 8)}…
          </div>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <span style={{
            fontSize: 11, fontWeight: 600,
            padding: '3px 10px',
            borderRadius: 20,
            background: sessionOk ? '#dcfce7' : '#fee2e2',
            color: sessionOk ? '#166534' : '#991b1b',
          }}>
            {sessionOk ? '● Live' : '✕ Offline'}
          </span>
        </div>
      </div>

      {/* Product selector */}
      <div style={{ padding: '12px 20px', background: 'rgba(255,255,255,0.03)' }}>
        <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>Product Type</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {['PCB', 'BISCUIT', 'AUTOMOTIVE'].map(p => (
            <button
              key={p}
              onClick={() => setProductType(p)}
              style={{
                padding: '6px 14px',
                borderRadius: 20,
                border: 'none',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 600,
                background: productType === p
                  ? 'linear-gradient(135deg,#3b82f6,#6366f1)'
                  : 'rgba(255,255,255,0.08)',
                color: productType === p ? '#fff' : '#94a3b8',
                transition: 'all 0.2s',
              }}
            >
              {p === 'AUTOMOTIVE' ? 'AUTO' : p}
            </button>
          ))}
        </div>
      </div>

      {/* Camera preview */}
      <div style={{ flex: 1, position: 'relative', background: '#000', overflow: 'hidden' }}>
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{
            width: '100%', height: '100%',
            objectFit: 'cover',
            opacity: camActive ? 1 : 0.2,
            transition: 'opacity 0.3s',
          }}
        />
        <canvas ref={canvasRef} style={{ display: 'none' }} />

        {/* Scanning overlay */}
        {status === 'scanning' && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.3)',
          }}>
            <div style={{
              background: 'rgba(255,255,255,0.1)',
              backdropFilter: 'blur(12px)',
              borderRadius: 16, padding: '16px 28px',
              display: 'flex', alignItems: 'center', gap: 10,
              fontSize: 14, fontWeight: 600,
            }}>
              <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span>
              Analyzing…
            </div>
          </div>
        )}

        {/* Corner aimer */}
        {camActive && status !== 'scanning' && (
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {[['0','0','right','bottom'],['auto','0','left','bottom'],
              ['0','auto','right','top'],['auto','auto','left','top']].map(([t,b,br,bl],i) => (
              <div key={i} style={{
                position:'absolute', top:t||undefined, bottom:b||undefined,
                width:40, height:40,
                borderTop: bl==='top' ? '3px solid #3b82f6' : undefined,
                borderBottom: bl==='bottom' ? '3px solid #3b82f6' : undefined,
                borderLeft: br==='right' ? '3px solid #3b82f6' : undefined,
                borderRight: br==='left' ? '3px solid #3b82f6' : undefined,
                left: br==='right' ? 24 : undefined,
                right: br==='left' ? 24 : undefined,
                marginTop: bl==='top' ? 60 : undefined,
                marginBottom: bl==='bottom' ? 20 : undefined,
              }}/>
            ))}
          </div>
        )}
      </div>

      {/* ── Camera error card ── */}
      {status === 'error' && camError && (
        <div style={{
          margin: '12px 20px 0',
          padding: '14px 16px',
          borderRadius: 14,
          background: '#1e1b2e',
          border: '1.5px solid #ef4444',
        }}>
          {/* Title row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 20 }}>
              {camError.type === 'insecure' ? '🔒' :
               camError.type === 'denied'   ? '🚫' :
               camError.type === 'busy'     ? '⏱️' : '⚠️'}
            </span>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#fca5a5' }}>
              {camError.title}
            </span>
          </div>

          {/* Message */}
          <div style={{
            fontSize: 12, color: '#cbd5e1', lineHeight: 1.6,
            whiteSpace: 'pre-wrap', marginBottom: 12,
          }}>
            {camError.msg}
          </div>

          {/* Debug info strip */}
          {showDebug && (
            <div style={{
              padding: '8px 10px', borderRadius: 8,
              background: 'rgba(255,255,255,0.05)',
              fontFamily: 'monospace', fontSize: 10, color: '#64748b',
              marginBottom: 12, lineHeight: 1.7,
            }}>
              <div>isSecureContext: <strong style={{ color: isSecure ? '#22c55e' : '#ef4444' }}>{String(isSecure)}</strong></div>
              <div>protocol: <strong style={{ color: '#94a3b8' }}>{window.location.protocol}</strong></div>
              <div>mediaDevices: <strong style={{ color: navigator.mediaDevices ? '#22c55e' : '#ef4444' }}>{navigator.mediaDevices ? 'available' : 'unavailable'}</strong></div>
              <div>error: <strong style={{ color: '#f87171' }}>{camError.type}</strong></div>
            </div>
          )}

          {/* Retry button — only for recoverable errors */}
          {camError.type !== 'insecure' && (
            <button
              onClick={startCamera}
              style={{
                width: '100%', padding: '12px',
                borderRadius: 12, border: 'none',
                background: 'linear-gradient(135deg,#3b82f6,#6366f1)',
                color: '#fff', fontWeight: 700, fontSize: 14,
                cursor: 'pointer', transition: 'opacity 0.2s',
              }}
            >
              🔄 Retry Camera Access
            </button>
          )}
        </div>
      )}

      {/* Result pill */}
      {lastResult && (
        <div style={{
          margin: '12px 20px 0',
          padding: '14px 18px',
          borderRadius: 14,
          background: resultStyle.bg,
          border: `1.5px solid ${resultStyle.border}`,
          transition: 'all 0.3s',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 22 }}>{resultStyle.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, color: resultStyle.text, fontSize: 15 }}>
                {lastResult.status}
              </div>
              <div style={{ fontSize: 11, color: resultStyle.text, opacity: 0.7 }}>
                Frame #{frameCount} · {lastResult.product || productType}
              </div>
            </div>
            <div style={{
              fontWeight: 800, fontSize: 18, color: resultStyle.text,
              background: 'rgba(0,0,0,0.07)', borderRadius: 8,
              padding: '2px 8px',
            }}>
              {Math.round((lastResult.confidence || 0) * 100)}%
            </div>
          </div>
          {lastResult.reason ? (
            <div style={{
              fontSize: 11, color: resultStyle.text, opacity: 0.8,
              lineHeight: 1.4, borderTop: `1px solid ${resultStyle.border}`,
              paddingTop: 6, marginTop: 2,
            }}>
              {lastResult.reason}
            </div>
          ) : null}
        </div>
      )}

      {/* Status text */}
      <div style={{
        textAlign: 'center', fontSize: 12, color: '#94a3b8',
        padding: '10px 20px 4px',
        minHeight: 32,
      }}>
        {statusLabel}
      </div>

      {/* Control buttons */}
      <div style={{ padding: '16px 20px 32px', display: 'flex', gap: 12 }}>
        {!camActive ? (
          <button
            onClick={startCamera}
            disabled={!sessionOk || status === 'expired'}
            style={{
              flex: 1, padding: '16px', borderRadius: 16, border: 'none',
              background: (sessionOk && status !== 'expired')
                ? 'linear-gradient(135deg,#3b82f6,#6366f1)'
                : 'rgba(255,255,255,0.08)',
              color: '#fff', fontWeight: 700, fontSize: 16,
              cursor: (sessionOk && status !== 'expired') ? 'pointer' : 'not-allowed',
              letterSpacing: '-0.01em',
              transition: 'all 0.2s',
            }}
          >
            📷 Start Camera
          </button>
        ) : (
          <>
            <button
              onClick={captureAndSend}
              disabled={status === 'scanning'}
              style={{
                flex: 2, padding: '16px', borderRadius: 16, border: 'none',
                background: 'linear-gradient(135deg,#3b82f6,#6366f1)',
                color: '#fff', fontWeight: 700, fontSize: 16,
                cursor: status === 'scanning' ? 'not-allowed' : 'pointer',
                opacity: status === 'scanning' ? 0.7 : 1,
                transition: 'all 0.2s',
              }}
            >
              {status === 'scanning' ? '⏳ Scanning…' : '📸 Capture Now'}
            </button>
            <button
              onClick={stopCamera}
              style={{
                padding: '16px 18px', borderRadius: 16, border: 'none',
                background: 'rgba(239,68,68,0.15)',
                color: '#ef4444', fontWeight: 700, fontSize: 14,
                cursor: 'pointer',
              }}
            >
              Stop
            </button>
          </>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
      `}</style>
    </div>
  );
}
