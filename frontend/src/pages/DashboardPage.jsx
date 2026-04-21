import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, Label,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import {
  TrendingUp, TrendingDown, CheckCircle2, XCircle, HelpCircle,
  Cpu, RefreshCw, Activity, Zap, Timer, AlertOctagon,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './DashboardPage.css';

const API = '/api';

// ─── Colour palette ───────────────────────────────────────────────────────────
const C = {
  pass:      '#22c55e',
  fail:      '#ef4444',
  uncertain: '#f59e0b',
  blue:      '#3b82f6',
  blue2:     '#6366f1',
  grid:      '#f1f5f9',
  passLight: '#dcfce7',
  failLight: '#fee2e2',
  uncLight:  '#fef3c7',
};

const STATUS_COLOR = { PASS: C.pass, FAIL: C.fail, UNCERTAIN: C.uncertain };
const PIE_COLORS   = [C.pass, C.fail, C.uncertain];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (n, d = 1) => (typeof n === 'number' ? n.toFixed(d) : '—');

const StatusBadge = ({ status }) => {
  const cfg = {
    PASS:      { bg: '#dcfce7', color: '#16a34a', icon: <CheckCircle2 size={12}/> },
    FAIL:      { bg: '#fee2e2', color: '#dc2626', icon: <XCircle size={12}/> },
    UNCERTAIN: { bg: '#fef3c7', color: '#d97706', icon: <HelpCircle size={12}/> },
  }[status] || { bg: '#f1f5f9', color: '#64748b', icon: null };

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: cfg.bg, color: cfg.color,
      padding: '2px 8px', borderRadius: 20,
      fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.02em',
    }}>
      {cfg.icon}{status}
    </span>
  );
};

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 14px', boxShadow: '0 4px 16px rgba(15,23,42,.1)', fontSize: '0.8rem' }}>
      <p style={{ color: '#64748b', marginBottom: 6, fontWeight: 600 }}>{label}</p>
      {payload.map(p => (
        <p key={p.name} style={{ color: p.color, margin: '2px 0' }}>
          {p.name}: <strong>{p.value}</strong>
        </p>
      ))}
    </div>
  );
};

// ─── Mini Sparkline (no axes, no tooltip) ────────────────────────────────────
const Sparkline = ({ data, color }) => {
  const pts = data || [0,0,0,0,0,0,0];
  return (
    <div className="db-kpi-sparkline">
      <ResponsiveContainer width="100%" height={40}>
        <AreaChart data={pts.map((v, i) => ({ i, v }))} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`sp-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={color} stopOpacity={0.25}/>
              <stop offset="95%" stopColor={color} stopOpacity={0}/>
            </linearGradient>
          </defs>
          <Area
            type="monotone" dataKey="v" stroke={color} strokeWidth={1.5}
            fill={`url(#sp-${color.replace('#', '')})`} dot={false} isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

// ─── KPI Card ─────────────────────────────────────────────────────────────────
const KpiCard = ({ label, value, sub, icon, accent, delay = 0, loading, sparkData }) => (
  <motion.div
    className="db-kpi-card"
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay, duration: 0.4, ease: [0.22,1,0.36,1] }}
    style={{ '--accent': accent }}
  >
    <div className="db-kpi-top">
      <span className="db-kpi-label">{label}</span>
      <div className="db-kpi-icon" style={{ background: accent + '18', color: accent }}>{icon}</div>
    </div>
    {loading ? (
      <div className="db-shimmer" style={{ height: 36, width: 100, marginTop: 6 }}/>
    ) : (
      <p className="db-kpi-value" style={{ color: accent }}>{value}</p>
    )}
    {sub && <p className="db-kpi-sub">{sub}</p>}
    {sparkData && !loading && <Sparkline data={sparkData} color={accent}/>}
  </motion.div>
);

// ─── Donut center label ───────────────────────────────────────────────────────
const DonutCenterLabel = ({ viewBox, total }) => {
  const { cx, cy } = viewBox;
  return (
    <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central">
      <tspan x={cx} dy="-0.4em" fontSize="22" fontWeight="800" fill="#0f172a">{total}</tspan>
      <tspan x={cx} dy="1.4em" fontSize="10" fill="#94a3b8" letterSpacing="0.05em">TOTAL</tspan>
    </text>
  );
};

// ─── Empty state ──────────────────────────────────────────────────────────────
const EmptyChart = ({ msg = 'No scan data yet. Run your first inspection.' }) => (
  <div className="db-empty">
    <Activity size={28} style={{ color: '#cbd5e1' }}/>
    <p>{msg}</p>
  </div>
);

// ═════════════════════════════════════════════════════════════════════════════
// Main DashboardPage
// ═════════════════════════════════════════════════════════════════════════════
const DashboardPage = () => {
  const { user } = useAuth();

  const [stats,   setStats]   = useState(null);
  const [scans,   setScans]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [lastRefreshed, setLastRefreshed] = useState('');

  // ── Fetch ───────────────────────────────────────────────────────────────
  const fetchData = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const [sr, sc] = await Promise.all([
        fetch(`${API}/stats`).then(r => r.json()),
        fetch(`${API}/scans?limit=20`).then(r => r.json()),
      ]);
      setStats(sr);
      setScans(Array.isArray(sc) ? sc : []);
      setLastRefreshed(new Date().toLocaleTimeString());
    } catch {/* backend offline — keep existing state */}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchData(true); }, [fetchData]);

  // Auto-refresh every 5 s — fast enough to show mobile results promptly
  useEffect(() => {
    const id = setInterval(() => fetchData(false), 5_000);
    return () => clearInterval(id);
  }, [fetchData, refresh]);

  // ── Derived data ─────────────────────────────────────────────────────────
  const pieData = stats ? [
    { name: 'Pass',      value: stats.pass      || 0 },
    { name: 'Fail',      value: stats.fail      || 0 },
    { name: 'Uncertain', value: stats.uncertain || 0 },
  ].filter(d => d.value > 0) : [];

  const barData = stats?.by_product
    ? Object.entries(stats.by_product).map(([name, v]) => ({
        name: name.length > 12 ? name.slice(0, 12) + '…' : name,
        Pass: v.pass || 0, Fail: v.fail || 0, Uncertain: v.uncertain || 0,
      }))
    : [];

  const timelineData = stats?.timeline || [];
  const sparkline    = stats?.sparkline || { total: [], pass: [], fail: [] };
  const totalScans   = stats?.total || 0;

  const firstNameDisplay = user?.name?.split(' ')[0] || 'Inspector';

  return (
    <div className="db-root">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <motion.div className="db-header"
        initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}>
        <div>
          <div className="db-header-eyebrow">
            <span className="db-status-dot"/> SYSTEM ACTIVE
          </div>
          <h1 className="db-title">Dashboard</h1>
          <p className="db-subtitle">Welcome back, <strong>{firstNameDisplay}</strong> — here's your inspection overview.</p>
        </div>
        <div className="db-header-actions">
          {lastRefreshed && <span className="db-last-refresh">Updated {lastRefreshed}</span>}
          <button className="db-refresh-btn" onClick={() => { setRefresh(r => r+1); fetchData(true); }} title="Refresh">
            <RefreshCw size={15} className={loading ? 'db-spin' : ''}/>
            <span>Refresh</span>
          </button>
        </div>
      </motion.div>

      {/* ── KPI Cards ─ 6 cards ─────────────────────────────────────────── */}
      <div className="db-kpi-grid">
        <KpiCard label="Total Scans"    value={stats?.total ?? '—'} sub="All time"
          icon={<Cpu size={18}/>} accent="#3b82f6" delay={0}    loading={loading}
          sparkData={sparkline.total}/>
        <KpiCard label="Pass"           value={stats ? `${stats.pass}` : '—'} sub={stats ? `${stats.pass_rate}% pass rate` : ''}
          icon={<CheckCircle2 size={18}/>} accent="#22c55e" delay={0.05} loading={loading}
          sparkData={sparkline.pass}/>
        <KpiCard label="Fail"           value={stats ? `${stats.fail}` : '—'} sub={stats ? `${stats.fail_rate}% fail rate` : ''}
          icon={<XCircle size={18}/>} accent="#ef4444" delay={0.10} loading={loading}
          sparkData={sparkline.fail}/>
        <KpiCard label="Avg Confidence" value={stats ? `${stats.avg_conf}%` : '—'} sub="Across all scans"
          icon={<TrendingUp size={18}/>} accent="#6366f1" delay={0.15} loading={loading}/>
        <KpiCard label="Defect Rate"    value={stats ? `${stats.defect_rate ?? 0}%` : '—'} sub="Last 24h"
          icon={<AlertOctagon size={18}/>} accent="#f59e0b" delay={0.20} loading={loading}/>
        <KpiCard label="Throughput"     value={stats ? `${stats.throughput_per_min ?? 0}/min` : '—'} sub="Last 60 seconds"
          icon={<Zap size={18}/>} accent="#0ea5e9" delay={0.25} loading={loading}/>
      </div>

      {/* ── Charts row ─────────────────────────────────────────────────── */}
      <div className="db-charts-row">

        {/* Area chart — scans over time with gradient fill */}
        <motion.div className="db-card db-card-wide"
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.28, duration: 0.4 }}>
          <div className="db-card-header">
            <h2 className="db-card-title">Scan Activity</h2>
            <span className="db-card-tag">per minute</span>
          </div>
          {timelineData.length === 0 ? <EmptyChart/> : (
            <ResponsiveContainer width="100%" height={210}>
              <AreaChart data={timelineData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="grad-pass" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={C.pass} stopOpacity={0.18}/>
                    <stop offset="95%" stopColor={C.pass} stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="grad-fail" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={C.fail} stopOpacity={0.15}/>
                    <stop offset="95%" stopColor={C.fail} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false}/>
                <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false}/>
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false}/>
                <Tooltip content={<CustomTooltip/>}/>
                <Area type="monotone" dataKey="pass"      stroke={C.pass}      strokeWidth={2} fill="url(#grad-pass)" dot={false} name="Pass"/>
                <Area type="monotone" dataKey="fail"      stroke={C.fail}      strokeWidth={2} fill="url(#grad-fail)" dot={false} name="Fail"/>
                <Line type="monotone" dataKey="uncertain" stroke={C.uncertain} strokeWidth={1.5} dot={false} name="Uncertain" strokeDasharray="4 3"/>
              </AreaChart>
            </ResponsiveContainer>
          )}
        </motion.div>

        {/* Donut chart — status distribution with center total */}
        <motion.div className="db-card db-card-narrow"
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.34, duration: 0.4 }}>
          <div className="db-card-header">
            <h2 className="db-card-title">Status Mix</h2>
          </div>
          {pieData.length === 0 ? <EmptyChart/> : (
            <div className="db-pie-wrap">
              <ResponsiveContainer width="100%" height={190}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={54} outerRadius={82}
                    paddingAngle={3} dataKey="value" stroke="none">
                    {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i]}/>)}
                    <Label content={<DonutCenterLabel total={totalScans}/>} position="center"/>
                  </Pie>
                  <Tooltip content={<CustomTooltip/>}/>
                </PieChart>
              </ResponsiveContainer>
              <div className="db-pie-legend">
                {pieData.map((d, i) => (
                  <div key={d.name} className="db-pie-legend-item">
                    <span className="db-pie-dot" style={{ background: PIE_COLORS[i] }}/>
                    <span className="db-pie-name">{d.name}</span>
                    <span className="db-pie-val">{d.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      </div>

      {/* ── Bar chart — by product ──────────────────────────────────────── */}
      <motion.div className="db-card"
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.40, duration: 0.4 }}>
        <div className="db-card-header">
          <h2 className="db-card-title">Results by Product Type</h2>
          <span className="db-card-tag">breakdown</span>
        </div>
        {barData.length === 0 ? <EmptyChart/> : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={barData} barSize={22} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false}/>
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false}/>
              <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false}/>
              <Tooltip content={<CustomTooltip/>}/>
              <Legend wrapperStyle={{ fontSize: '0.78rem', color: '#64748b' }}/>
              <Bar dataKey="Pass"      fill={C.pass}      radius={[4,4,0,0]} name="Pass"/>
              <Bar dataKey="Fail"      fill={C.fail}      radius={[4,4,0,0]} name="Fail"/>
              <Bar dataKey="Uncertain" fill={C.uncertain} radius={[4,4,0,0]} name="Uncertain"/>
            </BarChart>
          </ResponsiveContainer>
        )}
      </motion.div>

      {/* ── Scan History Table ─────────────────────────────────────────── */}
      <motion.div className="db-card"
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.45, duration: 0.4 }}>
        <div className="db-card-header">
          <h2 className="db-card-title">Recent Inspections</h2>
          <span className="db-card-tag">latest 20</span>
        </div>

        {scans.length === 0 ? (
          loading ? (
            <div className="db-table-skeleton">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="db-shimmer" style={{ height: 44, borderRadius: 8, marginBottom: 6 }}/>
              ))}
            </div>
          ) : <EmptyChart msg="No inspections yet — run a scan to see results here."/>
        ) : (
          <div className="db-table-wrap">
            <table className="db-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Product</th>
                  <th>Status</th>
                  <th>Confidence</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence initial={false}>
                  {scans.map((s, i) => (
                    <motion.tr key={s.scan_id || i}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.02 }}
                      className="db-table-row">
                      <td className="db-table-time">{s.timestamp?.slice(11, 16) || '—'}</td>
                      <td>
                        <span className="db-product-tag">{s.product_type || '—'}</span>
                      </td>
                      <td><StatusBadge status={s.status}/></td>
                      <td>
                        <div className="db-conf-cell">
                          <div className="db-conf-bar-bg">
                            <div className="db-conf-bar-fill"
                              style={{
                                width: `${Math.round((s.confidence || 0) * 100)}%`,
                                background: STATUS_COLOR[s.status] || C.blue,
                              }}/>
                          </div>
                          <span className="db-conf-pct">{Math.round((s.confidence || 0) * 100)}%</span>
                        </div>
                      </td>
                      <td className="db-table-note">{s.reason?.slice(0, 40) || '—'}</td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
        )}
      </motion.div>
    </div>
  );
};

export default DashboardPage;
