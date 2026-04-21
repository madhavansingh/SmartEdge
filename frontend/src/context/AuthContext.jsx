import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const AuthContext = createContext(null);

// ─── Your Google OAuth Client ID ────────────────────────────────────────────
// Replace this with your real Client ID from console.cloud.google.com
// Allowed origins must include http://localhost:5173
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

const SESSION_KEY = 'smartedge_session';
const API = 'http://localhost:8000';

export const AuthProvider = ({ children }) => {
  const [user, setUser]       = useState(null);   // { name, email, picture, session_token }
  const [loading, setLoading] = useState(true);    // true while restoring session
  const [error, setError]     = useState('');

  // ── Restore session from localStorage on mount ────────────────────────────
  useEffect(() => {
    const stored = localStorage.getItem(SESSION_KEY);
    if (!stored) { setLoading(false); return; }

    const { session_token } = JSON.parse(stored);
    fetch(`${API}/auth/session?token=${session_token}`)
      .then(r => r.ok ? r.json() : null)
      .then(u => {
        if (u) setUser({ ...u, session_token });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // ── Called by LoginPage after GIS returns a credential ───────────────────
  const loginWithCredential = useCallback(async (credential) => {
    setError('');
    try {
      const res = await fetch(`${API}/auth/google`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ credential }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Login failed');
      }
      const data = await res.json();
      setUser(data);
      localStorage.setItem(SESSION_KEY, JSON.stringify({ session_token: data.session_token }));
      sessionStorage.setItem('se_login_time', String(Date.now()));
      return data;
    } catch (e) {
      setError(e.message || 'Google sign-in failed. Please try again.');
      throw e;
    }
  }, []);

  // ── Logout ────────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    if (user?.session_token) {
      fetch(`${API}/auth/logout`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ session_token: user.session_token }),
      }).catch(() => {});
    }
    // Revoke Google session
    if (window.google?.accounts?.id) {
      window.google.accounts.id.disableAutoSelect();
    }
    setUser(null);
    localStorage.removeItem(SESSION_KEY);
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, error, setError, loginWithCredential, logout, GOOGLE_CLIENT_ID }}>
      {children}
    </AuthContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);
