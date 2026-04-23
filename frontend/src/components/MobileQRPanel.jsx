/**
 * MobileQRPanel.jsx
 *
 * Shows a QR code for the current mobile session.
 * Primary transport: WebSocket (/ws/{sessionId}) — results pushed <100ms.
 * Fallback: HTTP polling every 2s if WebSocket unavailable/fails.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import QRCode from 'qrcode';

// All laptop→backend API calls go through Vite's dev-server proxy (/api → localhost:8000)
const API_BASE  = '/api';
const POLL_MS   = 2000;   // fallback polling interval (only used if WS fails)

/**
 * Fetches the server's real LAN IP dynamically via /api/server-info.
 * Falls back to VITE_LAN_IP env var, then to window.location.hostname.
 * This prevents stale hardcoded IPs from breaking QR codes.
 */
async function getLanBaseUrl() {
  const port = window.location.port || '5173';
  const hostname = window.location.hostname;

  // Already on a real LAN address (phone opened page via IP) — reuse it
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
    return window.location.origin;
  }

  // Try to get the live LAN IP from the backend
  try {
    const res = await fetch('/api/server-info', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      if (data.lan_ip && data.lan_ip !== '127.0.0.1') {
        return `http://${data.lan_ip}:${port}`;
      }
    }
  } catch { /* fall through */ }

  // Fallback: use env var
  const envIp = import.meta.env.VITE_LAN_IP;
  if (envIp && envIp !== '127.0.0.1') {
    return `http://${envIp}:${port}`;
  }

  // Last resort: same origin (works if Vite is already bound to LAN)
  return window.location.origin;
}

// ── QR rendered locally via 'qrcode' npm package — no external API needed ────
function QRImage({ url, size = 200 }) {
  const canvasRef = useRef(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!url || !canvasRef.current) return;
    setError(false);
    QRCode.toCanvas(canvasRef.current, url, {
      width: size,
      margin: 2,
      color: { dark: '#1e293b', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    }).catch(() => setError(true));
  }, [url, size]);

  if (error) {
    return (
      <div style={{
        width: size, height: size,
        background: '#fff', borderRadius: 12,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: 16, textAlign: 'center',
        border: '2px dashed #cbd5e1',
      }}>
        <div style={{ fontSize: 11, color: '#475569', wordBreak: 'break-all' }}>{url}</div>
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      style={{ borderRadius: 12, display: 'block' }}
      width={size}
      height={size}
    />
  );
}

// ── Status badge ─────────────────────────────────────────────────────────────
const STATUS_COLOURS = {
  PASS:      { bg: '#dcfce7', text: '#166534', dot: '#22c55e' },
  FAIL:      { bg: '#fee2e2', text: '#991b1b', dot: '#ef4444' },
  UNCERTAIN: { bg: '#fef9c3', text: '#78350f', dot: '#f59e0b' },
};

function StatusBadge({ status }) {
  const c = STATUS_COLOURS[status] || { bg: '#f1f5f9', text: '#475569', dot: '#94a3b8' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 12px', borderRadius: 20,
      background: c.bg, color: c.text,
      fontWeight: 700, fontSize: 13,
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.dot, display: 'inline-block' }} />
      {status}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function MobileQRPanel({ productType = 'PCB', onResult, onClose, userEmail = '' }) {
  const [phase, setPhase]           = useState('creating');
  const [sessionId, setSessionId]   = useState(null);
  const [mobileUrl, setMobileUrl]   = useState('');
  const [frameCount, setFrameCount] = useState(0);
  const [lastResult, setLastResult] = useState(null);
  const [errMsg, setErrMsg]         = useState('');
  const [transport, setTransport]   = useState('ws');   // 'ws' | 'poll'

  const wsRef        = useRef(null);
  const pollRef      = useRef(null);
  const prevFrameRef = useRef(0);
  const sidRef       = useRef(null);   // stable ref for cleanup callbacks

  // ── Handle incoming result (shared between WS and poll paths) ─────────────
  const handleResult = useCallback((data) => {
    const fc = data.frame || data.frame_count || 0;
    if (fc > 0 && fc !== prevFrameRef.current) {
      prevFrameRef.current = fc;
      setFrameCount(fc);
      setPhase('connected');
      const result = data.result || data;   // WS sends flat; poll wraps in {result}
      if (result.status) {
        setLastResult(result);
        onResult?.(result);
      }
    } else if (data.frame_count > 0 || data.connected) {
      setPhase('connected');
    }
  }, [onResult]);

  // ── Create session on mount ───────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sessionRes, baseUrl] = await Promise.all([
          fetch(`${API_BASE}/mobile-session/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product_type: productType, user_email: userEmail }),
          }),
          getLanBaseUrl(),
        ]);
        const data = await sessionRes.json();
        if (cancelled) return;
        const sid = data.session_id;
        sidRef.current = sid;
        setSessionId(sid);
        setMobileUrl(`${baseUrl}/mobile/${sid}`);
        setPhase('waiting');
      } catch {
        if (!cancelled) {
          setErrMsg('Could not reach backend. Make sure the server is running.');
          setPhase('error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [productType]);

  // ── WebSocket connection (primary transport) ───────────────────────────────
  useEffect(() => {
    if (!sessionId || phase === 'creating' || phase === 'expired' || phase === 'error') return;

    let ws;
    let fallbackTimer;
    let dead = false;

    const connect = () => {
      // Build WS URL — use same host so Vite proxy handles it
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl = `${proto}://${window.location.host}/ws/${sessionId}`;

      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      // Give WS 4 seconds to connect; if not, fall back to polling
      fallbackTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          console.warn('[MobileQRPanel] WS not open after 4s — switching to polling');
          ws.close();
          startPolling();
        }
      }, 4000);

      ws.onopen = () => {
        clearTimeout(fallbackTimer);
        setTransport('ws');
        console.info('[MobileQRPanel] WebSocket connected');
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'ping') return;   // server keep-alive, ignore
          if (msg.type === 'connected') {
            if (msg.frame_count > 0) setPhase('connected');
            return;
          }
          if (msg.type === 'result') {
            handleResult(msg);
          }
        } catch { /* malformed JSON — ignore */ }
      };

      ws.onerror = () => {
        clearTimeout(fallbackTimer);
        console.warn('[MobileQRPanel] WS error — falling back to polling');
      };

      ws.onclose = () => {
        clearTimeout(fallbackTimer);
        if (!dead) {
          // Auto-reconnect after 3 s (handles proxy hiccups)
          console.info('[MobileQRPanel] WS closed — reconnecting in 3s');
          setTimeout(() => { if (!dead) connect(); }, 3000);
        }
      };
    };

    const startPolling = () => {
      if (pollRef.current) return;   // already polling
      setTransport('poll');
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`${API_BASE}/mobile-result/${sidRef.current}`);
          if (res.status === 404) {
            setPhase('expired');
            clearInterval(pollRef.current);
            return;
          }
          handleResult(await res.json());
        } catch { /* network hiccup — keep polling */ }
      }, POLL_MS);
    };

    connect();

    return () => {
      dead = true;
      clearTimeout(fallbackTimer);
      ws?.close();
      clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [sessionId, phase, handleResult]);

  // ── Copy URL to clipboard ─────────────────────────────────────────────────
  const [copied, setCopied] = useState(false);
  const copyUrl = useCallback(() => {
    if (!mobileUrl) return;
    navigator.clipboard?.writeText(mobileUrl).catch(() => {
      // Fallback for browsers without clipboard API
      const ta = document.createElement('textarea');
      ta.value = mobileUrl;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [mobileUrl]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{
      background: '#fff',
      borderRadius: 20,
      padding: 28,
      boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
      border: '1.5px solid #e2e8f0',
      width: 340,
      position: 'relative',
    }}>
      {/* Close button */}
      <button
        onClick={onClose}
        style={{
          position: 'absolute', top: 14, right: 14,
          width: 28, height: 28, borderRadius: '50%',
          background: '#f1f5f9', border: 'none', cursor: 'pointer',
          fontSize: 14, color: '#64748b',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >✕</button>

      {/* Title */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 800, fontSize: 17, color: '#1e293b', letterSpacing: '-0.02em' }}>
          📱 Mobile Camera
        </div>
        <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>
          Scan with your phone to stream live frames
        </div>
      </div>

      {/* ── Phase: creating ── */}
      {phase === 'creating' && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: '#94a3b8' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>⏳</div>
          <div style={{ fontSize: 13 }}>Creating session…</div>
        </div>
      )}

      {/* ── Phase: error ── */}
      {phase === 'error' && (
        <div style={{
          padding: 16, borderRadius: 12,
          background: '#fee2e2', color: '#991b1b', fontSize: 13,
        }}>
          {errMsg}
        </div>
      )}

      {/* ── Phase: expired ── */}
      {phase === 'expired' && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>⏱️</div>
          <div style={{ fontSize: 13, color: '#64748b' }}>
            Session expired (5 min idle). Click <strong>Mobile Mode</strong> again to start a new session.
          </div>
        </div>
      )}

      {/* ── Phase: waiting / connected ── */}
      {(phase === 'waiting' || phase === 'connected') && sessionId && (
        <>
          {/* Connection status */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 12px', borderRadius: 10,
            background: phase === 'connected' ? '#dcfce7' : '#f0f9ff',
            marginBottom: 18,
            fontSize: 12, fontWeight: 600,
            color: phase === 'connected' ? '#166534' : '#0369a1',
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: phase === 'connected' ? '#22c55e' : '#3b82f6',
              display: 'inline-block',
              animation: phase === 'connected' ? 'none' : 'pulse 1.5s ease-in-out infinite',
            }}/>
            {phase === 'connected'
              ? `Connected · ${frameCount} frame${frameCount !== 1 ? 's' : ''} · ${transport === 'ws' ? '⚡ Real-time' : '↺ Polling'}`
              : 'Waiting for phone connection…'}
          </div>

          {/* QR code */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
            <div style={{ position: 'relative' }}>
              <QRImage url={mobileUrl} size={180} />
              {phase === 'connected' && (
                <div style={{
                  position: 'absolute', inset: 0,
                  background: 'rgba(22,163,74,0.08)',
                  borderRadius: 12,
                  border: '2px solid #22c55e',
                }}/>
              )}
            </div>
          </div>

          {/* URL + copy */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 12px', borderRadius: 10,
            background: '#f8fafc', border: '1.5px solid #e2e8f0',
            marginBottom: 10,
          }}>
            <div style={{
              flex: 1, fontSize: 11, color: '#475569',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontFamily: 'monospace',
            }}>
              {mobileUrl}
            </div>
            <button
              onClick={copyUrl}
              style={{
                padding: '4px 10px', borderRadius: 6,
                background: copied ? '#22c55e' : '#3b82f6',
                color: '#fff',
                border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: 700, flexShrink: 0,
                transition: 'background 0.2s',
                minWidth: 52,
              }}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>

          {/* WiFi reminder */}
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: '8px 12px', borderRadius: 10,
            background: '#fffbeb', border: '1.5px solid #fcd34d',
            marginBottom: 14, fontSize: 11, color: '#78350f', lineHeight: 1.5,
          }}>
            <span style={{ fontSize: 14, flexShrink: 0 }}>📡</span>
            <span>
              <strong>Make sure phone and laptop are on the same Wi-Fi</strong>
              {' '}network. Otherwise the QR code will not open.
            </span>
          </div>

          {/* Instructions */}
          <div style={{
            padding: '10px 12px', borderRadius: 10,
            background: '#f0f9ff', border: '1px solid #bae6fd',
            fontSize: 11, color: '#0369a1', lineHeight: 1.6,
          }}>
            <strong>How to use:</strong><br />
            1. Make sure phone & laptop are on the <strong>same Wi-Fi</strong><br />
            2. Scan the QR code with your phone camera<br />
            3. Allow camera access → scanning starts automatically
          </div>

          {/* Last result */}
          {lastResult && (
            <div style={{
              marginTop: 16, padding: '12px 14px', borderRadius: 12,
              background: '#f8fafc', border: '1px solid #e2e8f0',
            }}>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8, fontWeight: 600 }}>
                LATEST RESULT
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <StatusBadge status={lastResult.status} />
                <span style={{ fontSize: 11, color: '#64748b' }}>
                  {Math.round((lastResult.confidence || 0) * 100)}% conf
                </span>
              </div>
              {lastResult.reason && (
                <div style={{
                  marginTop: 8, fontSize: 11, color: '#64748b',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                  display: '-webkit-box', WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                }}>
                  {lastResult.reason}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <style>{`
        @keyframes pulse {
          0%,100% { opacity:1; transform:scale(1); }
          50%      { opacity:0.5; transform:scale(1.4); }
        }
      `}</style>
    </div>
  );
}
