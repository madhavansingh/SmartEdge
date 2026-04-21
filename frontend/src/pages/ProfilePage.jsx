import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { LogOut, Shield, Clock, Mail, User, ChevronRight } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './ProfilePage.css';

const fadeUp = {
  hidden: { opacity: 0, y: 18 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.3 } },
};

const ProfilePage = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  // Safe fallbacks when user object may be partial
  const name    = user?.name    || user?.email?.split('@')[0] || 'User';
  const email   = user?.email   || '—';
  const picture = user?.picture || null;
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  const loginTime = (() => {
    const raw = sessionStorage.getItem('se_login_time');
    if (!raw) return 'This session';
    try { return new Date(Number(raw)).toLocaleString(); } catch { return 'This session'; }
  })();

  return (
    <div className="profile-root">

      {/* Page title */}
      <motion.div className="profile-page-header" variants={fadeUp} initial="hidden" animate="show">
        <h1 className="profile-page-title">Profile</h1>
        <p className="profile-page-sub">Manage your account and identity</p>
      </motion.div>

      {/* Avatar card */}
      <motion.div
        className="profile-card profile-avatar-card"
        variants={fadeUp} initial="hidden" animate="show"
        transition={{ delay: 0.05 }}
      >
        <div className="profile-avatar-wrap">
          {picture
            ? <img src={picture} alt={name} className="profile-avatar-img" referrerPolicy="no-referrer" />
            : <div className="profile-avatar-placeholder">{initials}</div>
          }
          <span className="profile-avatar-badge">
            <Shield size={10} /> Verified
          </span>
        </div>

        <div className="profile-avatar-info">
          <h2 className="profile-name">{name}</h2>
          <p className="profile-email"><Mail size={14}/>{email}</p>
        </div>
      </motion.div>

      {/* Info rows */}
      <motion.div
        className="profile-card"
        variants={fadeUp} initial="hidden" animate="show"
        transition={{ delay: 0.1 }}
      >
        <h3 className="profile-section-title">Account Details</h3>

        <div className="profile-info-list">
          <div className="profile-info-row">
            <div className="profile-info-left">
              <div className="profile-info-icon" style={{ background: '#eff6ff', color: '#2563eb' }}>
                <User size={15}/>
              </div>
              <div>
                <p className="profile-info-label">Role</p>
                <p className="profile-info-value">Operator</p>
              </div>
            </div>
            <span className="profile-info-badge">Active</span>
          </div>

          <div className="profile-info-row">
            <div className="profile-info-left">
              <div className="profile-info-icon" style={{ background: '#f0fdf4', color: '#16a34a' }}>
                <Clock size={15}/>
              </div>
              <div>
                <p className="profile-info-label">Last login</p>
                <p className="profile-info-value">{loginTime}</p>
              </div>
            </div>
          </div>

          <div className="profile-info-row">
            <div className="profile-info-left">
              <div className="profile-info-icon" style={{ background: '#fefce8', color: '#ca8a04' }}>
                <Shield size={15}/>
              </div>
              <div>
                <p className="profile-info-label">Auth provider</p>
                <p className="profile-info-value">Google Sign-In</p>
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Quick links */}
      <motion.div
        className="profile-card"
        variants={fadeUp} initial="hidden" animate="show"
        transition={{ delay: 0.15 }}
      >
        <h3 className="profile-section-title">Quick Actions</h3>
        <div className="profile-actions-list">
          <button className="profile-action-row" onClick={() => navigate('/settings')}>
            <span>Go to Settings</span>
            <ChevronRight size={16} className="profile-chevron"/>
          </button>
          <button className="profile-action-row profile-action-row-danger" onClick={handleLogout}>
            <span className="profile-action-danger-left">
              <LogOut size={15}/> Sign out
            </span>
          </button>
        </div>
      </motion.div>

    </div>
  );
};

export default ProfilePage;
