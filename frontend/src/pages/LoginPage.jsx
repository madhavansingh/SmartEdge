import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Cpu, AlertCircle, Loader2 } from 'lucide-react';
import { useAuth, GOOGLE_CLIENT_ID } from '../context/AuthContext';
import './LoginPage.css';

const LoginPage = () => {
  const navigate = useNavigate();
  const { user, loginWithCredential, error, setError, loading: authLoading } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  const btnRef = useRef(null);
  const gisReady = useRef(false);

  // If already logged in, go straight to dashboard
  useEffect(() => {
    if (!authLoading && user) navigate('/dashboard', { replace: true });
  }, [user, authLoading, navigate]);

  // Initialise Google Identity Services once the script loads
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return; // no Client ID configured yet

    const init = () => {
      if (!window.google?.accounts?.id || gisReady.current) return;
      gisReady.current = true;

      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback:  handleCredential,
        ux_mode:   'popup',
      });

      if (btnRef.current) {
        window.google.accounts.id.renderButton(btnRef.current, {
          theme:  'outline',
          size:   'large',
          width:  320,
          text:   'continue_with',
          shape:  'rectangular',
          logo_alignment: 'left',
        });
      }
    };

    // Script may already be loaded or still loading
    if (window.google?.accounts?.id) { init(); }
    else {
      const interval = setInterval(() => {
        if (window.google?.accounts?.id) { clearInterval(interval); init(); }
      }, 150);
      return () => clearInterval(interval);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCredential = async (response) => {
    setSigningIn(true);
    setError('');
    try {
      await loginWithCredential(response.credential);
      navigate('/dashboard', { replace: true });
    } catch {
      // error already set by AuthContext
    } finally {
      setSigningIn(false);
    }
  };

  // Fallback manual trigger (for custom button when GIS button not rendered)
  const triggerGIS = () => {
    if (!GOOGLE_CLIENT_ID) {
      setError('Google Client ID not configured. Add VITE_GOOGLE_CLIENT_ID to your .env file.');
      return;
    }
    if (window.google?.accounts?.id) {
      window.google.accounts.id.prompt();
    }
  };

  if (authLoading) {
    return (
      <div className="lp-login-loading">
        <Loader2 size={28} className="lp-spin" />
      </div>
    );
  }

  return (
    <div className="login-root">
      {/* Background blobs */}
      <div className="login-blob login-blob1" />
      <div className="login-blob login-blob2" />
      <div className="login-grid" />

      <motion.div
        className="login-card"
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        {/* Logo */}
        <div className="login-logo">
          <div className="login-logo-icon"><Cpu size={22} /></div>
          <div>
            <p className="login-logo-name">SmartEdge<span>AI</span></p>
            <p className="login-logo-sub">Inspector Platform</p>
          </div>
        </div>

        <div className="login-divider" />

        <h1 className="login-title">Login to SmartEdge</h1>
        <p className="login-desc">Sign in with your Google account to access the inspection dashboard.</p>

        {/* Google button rendered by GIS SDK */}
        <div className="login-google-wrap">
          {GOOGLE_CLIENT_ID ? (
            <>
              {/* GIS renders into this div */}
              <div ref={btnRef} className="login-gis-btn" />

              {/* Shown while signing in */}
              <AnimatePresence>
                {signingIn && (
                  <motion.div
                    className="login-signing-overlay"
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  >
                    <Loader2 size={18} className="lp-spin" />
                    <span>Signing you in…</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          ) : (
            /* Fallback when Client ID not set */
            <button className="login-custom-btn" onClick={triggerGIS}>
              <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
                <path d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34 6.5 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" fill="#FFC107"/>
                <path d="M6.3 14.7l6.6 4.8C14.7 16.1 19 13 24 13c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34 6.5 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" fill="#FF3D00"/>
                <path d="M24 44c5.2 0 9.8-2 13.3-5.1l-6.1-5.2C29.2 35.3 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8H6.3C9.7 35.7 16.3 44 24 44z" fill="#4CAF50"/>
                <path d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.5l6.1 5.2C37 38.2 44 33 44 24c0-1.2-.1-2.3-.4-3.5z" fill="#1976D2"/>
              </svg>
              Continue with Google
            </button>
          )}
        </div>

        {/* Error message */}
        <AnimatePresence>
          {error && (
            <motion.div
              className="login-error"
              initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            >
              <AlertCircle size={14} />
              <span>{error}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* No signup note */}
        {!GOOGLE_CLIENT_ID && (
          <div className="login-setup-note">
            <p>⚙️ <strong>Setup required:</strong></p>
            <p>Add <code>VITE_GOOGLE_CLIENT_ID=your_id</code> to <code>frontend/.env</code></p>
            <p>Get a Client ID at <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">console.cloud.google.com</a></p>
          </div>
        )}

        <p className="login-footnote">No account creation needed · Google sign-in only</p>
      </motion.div>
    </div>
  );
};

export default LoginPage;
