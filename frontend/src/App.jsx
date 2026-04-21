import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { SystemProvider }   from './context/SystemContext';
import { AuthProvider }     from './context/AuthContext';
import { SettingsProvider } from './context/SettingsContext';
import ProtectedRoute from './components/ProtectedRoute';
import Layout         from './components/Layout';
import './design-system.css';

// Lazy-load all pages for performance
const LandingPage   = lazy(() => import('./pages/LandingPage'));
const LoginPage     = lazy(() => import('./pages/LoginPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const InspectPage   = lazy(() => import('./pages/InspectPage'));
const ReportsPage   = lazy(() => import('./pages/ReportsPage'));
const ProfilePage   = lazy(() => import('./pages/ProfilePage'));
const SettingsPage  = lazy(() => import('./pages/SettingsPage'));
const MobilePage    = lazy(() => import('./pages/MobilePage'));

// Lightweight page skeleton shown during lazy-load
const PageSkeleton = () => (
  <div style={{ padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
    {[1,2,3].map(i => (
      <div key={i} className="skeleton" style={{ height: i === 1 ? '2.5rem' : '1.1rem', width: i === 1 ? '40%' : `${60 + i * 8}%` }} />
    ))}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '1rem', marginTop: '0.5rem' }}>
      {[1,2,3,4].map(i => <div key={i} className="skeleton" style={{ height: '110px', borderRadius: '14px' }}/>)}
    </div>
  </div>
);

function App() {
  return (
    <AuthProvider>
      <SettingsProvider>
        <SystemProvider>
          <Router>
            <Suspense fallback={<PageSkeleton />}>
            <Routes>
              {/* Public */}
              <Route path="/"      element={<LandingPage />} />
              <Route path="/login" element={<LoginPage />} />

              {/* Mobile camera page — public, no auth, full-screen */}
              <Route path="/mobile/:sessionId" element={<MobilePage />} />

              {/* Protected — wrapped in sidebar Layout */}
              <Route
                element={
                  <ProtectedRoute>
                    <Layout />
                  </ProtectedRoute>
                }
              >
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/inspect"   element={<InspectPage />} />
                <Route path="/reports"   element={<ReportsPage />} />
                <Route path="/profile"   element={<ProfilePage />} />
                <Route path="/settings"  element={<SettingsPage />} />
              </Route>

              {/* Fallback */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </Suspense>
          </Router>
        </SystemProvider>
      </SettingsProvider>
    </AuthProvider>
  );
}

export default App;
