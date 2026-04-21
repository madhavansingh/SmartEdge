import './ReportsPage.css';
import { useSystem } from '../context/SystemContext';
import { toast } from '../utils/toast';
import {
  Download, FileText, RefreshCw, Filter,
  CheckCircle, AlertTriangle, HelpCircle,
  TrendingUp, BarChart2, ArrowUpDown, ArrowUp, ArrowDown,
  FileDown, Calendar,
} from 'lucide-react';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';

// Uses Vite proxy (/api/*) → localhost:8000, works from both laptop and phone
const API_BASE = '/api';

// ── Helpers ───────────────────────────────────────────────────────────────────
const pct = (n, total) => (total ? ((n / total) * 100).toFixed(1) : '0.0');
const today = () => new Date().toISOString().slice(0, 10);
const thirtyDaysAgo = () => {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
};

const PIE_COLORS = { PASS: '#22c55e', FAIL: '#ef4444', UNCERTAIN: '#f59e0b' };

// ── Sub-components ────────────────────────────────────────────────────────────
const StatusBadge = ({ status }) => {
  const cfg = {
    PASS:      { icon: <CheckCircle size={11}/>,  cls: 'rp-badge-pass' },
    FAIL:      { icon: <AlertTriangle size={11}/>, cls: 'rp-badge-fail' },
    UNCERTAIN: { icon: <HelpCircle size={11}/>,    cls: 'rp-badge-unc' },
  }[status] || { icon: null, cls: 'rp-badge-unc' };
  return (
    <span className={`rp-badge ${cfg.cls}`}>
      {cfg.icon} {status || '—'}
    </span>
  );
};

const KPICard = ({ label, value, sub, accent }) => (
  <div className="rp-kpi-card" style={{ '--accent': accent }}>
    <div className="rp-kpi-value" style={{ color: accent }}>{value}</div>
    <div className="rp-kpi-label">{label}</div>
    {sub && <div className="rp-kpi-sub">{sub}</div>}
  </div>
);

const ConfBar = ({ value }) => {
  const pct = Math.round(value * 100);
  const col  = pct > 75 ? '#22c55e' : pct > 45 ? '#f59e0b' : '#ef4444';
  return (
    <div className="rp-conf-cell">
      <div className="rp-conf-track">
        <div className="rp-conf-fill" style={{ width: `${pct}%`, background: col }}/>
      </div>
      <span>{pct}%</span>
    </div>
  );
};

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rp-tooltip">
      <div className="rp-tooltip-label">{label}</div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ color: p.color, fontSize: 12 }}>
          {p.name}: <strong>{p.value}</strong>
        </div>
      ))}
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────
const ReportsPage = () => {
  const { auditLogs, batches } = useSystem();

  // Filters
  const [fromDate,       setFromDate]       = useState(thirtyDaysAgo());
  const [toDate,         setToDate]         = useState(today());
  const [productFilter,  setProductFilter]  = useState('All');
  const [statusFilter,   setStatusFilter]   = useState('All');

  // Data
  const [scans,    setScans]    = useState([]);
  const [stats,    setStats]    = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [lastSync, setLastSync] = useState(null);

  // Table state
  const [sortCol,  setSortCol]  = useState('timestamp');
  const [sortDir,  setSortDir]  = useState('desc');
  const [page,     setPage]     = useState(0);
  const PAGE_SIZE = 20;

  // Export state
  const [dlCsv, setDlCsv] = useState(false);
  const [dlPdf, setDlPdf] = useState(false);

  // Active tab
  const [tab, setTab] = useState('overview');  // overview | records | batches | audit

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const buildQS = useCallback(() => {
    const p = new URLSearchParams();
    if (productFilter !== 'All') p.set('product', productFilter);
    if (statusFilter  !== 'All') p.set('status',  statusFilter);
    if (fromDate) p.set('from_date', fromDate);
    if (toDate)   p.set('to_date',   toDate);
    p.set('limit', '500');
    return p.toString();
  }, [productFilter, statusFilter, fromDate, toDate]);

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const qs = buildQS();
      const [scanRes, statsRes] = await Promise.all([
        fetch(`${API_BASE}/scans?${qs}`),
        fetch(`${API_BASE}/stats?${qs}`),
      ]);
      if (scanRes.ok)  setScans(await scanRes.json());
      if (statsRes.ok) setStats(await statsRes.json());
      setLastSync(new Date().toLocaleTimeString());
    } catch {/* backend offline */}
    finally { if (!silent) { setLoading(false); setPage(0); } }
  }, [buildQS]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-refresh every 10 s — picks up mobile results without manual refresh
  useEffect(() => {
    const id = setInterval(() => fetchData(true), 10_000);
    return () => clearInterval(id);
  }, [fetchData]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const sortedScans = useMemo(() => {
    const arr = [...scans];
    arr.sort((a, b) => {
      let va = a[sortCol] ?? '';
      let vb = b[sortCol] ?? '';
      if (sortCol === 'confidence') { va = +va; vb = +vb; }
      return sortDir === 'asc'
        ? String(va).localeCompare(String(vb), undefined, { numeric: true })
        : String(vb).localeCompare(String(va), undefined, { numeric: true });
    });
    return arr;
  }, [scans, sortCol, sortDir]);

  const pagedScans = sortedScans.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(sortedScans.length / PAGE_SIZE);

  const pieData = stats ? [
    { name: 'PASS',      value: stats.pass      || 0 },
    { name: 'FAIL',      value: stats.fail       || 0 },
    { name: 'UNCERTAIN', value: stats.uncertain  || 0 },
  ].filter(d => d.value > 0) : [];

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  const SortIcon = ({ col }) => {
    if (sortCol !== col) return <ArrowUpDown size={12} style={{ opacity: 0.3 }}/>;
    return sortDir === 'asc' ? <ArrowUp size={12}/> : <ArrowDown size={12}/>;
  };

  // ── Downloads ──────────────────────────────────────────────────────────────
  const triggerDownload = async (format) => {
    const setter = format === 'csv' ? setDlCsv : setDlPdf;
    setter(true);
    try {
      const qs = buildQS();
      const url = `${API_BASE}/report/${format}?${qs}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = href;
      a.download = `smartedge_report_${Date.now()}.${format}`;
      a.click();
      URL.revokeObjectURL(href);
      toast.success(`${format.toUpperCase()} downloaded successfully`);
    } catch {
      toast.error(`${format.toUpperCase()} export failed — trying client fallback`);
      // Client-side CSV fallback (only for csv)
      if (format === 'csv') {
        let csv = 'timestamp,product_type,status,confidence,reason,source\n';
        scans.forEach(s => {
          csv += `${s.timestamp},${s.product_type},${s.status},${((s.confidence||0)*100).toFixed(1)}%,"${(s.reason||'').replace(/"/g,'""')}",${s.source||''}\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href; a.download = `smartedge_report_${Date.now()}.csv`; a.click();
        URL.revokeObjectURL(href);
      }
    } finally { setter(false); }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="rp-root">

      {/* ── Page header ── */}
      <header className="rp-header">
        <div>
          <h1 className="rp-title">Reports &amp; Analytics</h1>
          <p className="rp-subtitle">
            Real-time inspection intelligence · {lastSync ? `Updated ${lastSync}` : 'Loading…'}
          </p>
        </div>
        <div className="rp-header-actions">
          <button className="rp-btn rp-btn-ghost" onClick={fetchData} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'rp-spin' : ''}/>
            Refresh
          </button>
          <button className="rp-btn rp-btn-outline" onClick={() => triggerDownload('csv')} disabled={dlCsv || scans.length === 0}>
            <FileDown size={14}/>{dlCsv ? 'Exporting…' : 'Export CSV'}
          </button>
          <button className="rp-btn rp-btn-primary" onClick={() => triggerDownload('pdf')} disabled={dlPdf || scans.length === 0}>
            <Download size={14}/>{dlPdf ? 'Generating…' : 'Export PDF'}
          </button>
        </div>
      </header>

      {/* ── Filter bar ── */}
      <div className="rp-filter-bar">
        <div className="rp-filter-group">
          <Calendar size={14} className="rp-filter-icon"/>
          <input type="date" className="rp-date-input" value={fromDate} max={toDate}
            onChange={e => setFromDate(e.target.value)}/>
          <span className="rp-filter-sep">→</span>
          <input type="date" className="rp-date-input" value={toDate} min={fromDate}
            onChange={e => setToDate(e.target.value)}/>
        </div>
        <div className="rp-filter-group">
          <Filter size={14} className="rp-filter-icon"/>
          <select className="rp-select" value={productFilter} onChange={e => setProductFilter(e.target.value)}>
            <option value="All">All Products</option>
            <option value="PCB">PCB</option>
            <option value="BISCUIT">Biscuit</option>
            <option value="AUTOMOTIVE">Automotive</option>
          </select>
          <select className="rp-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="All">All Statuses</option>
            <option value="PASS">Pass</option>
            <option value="FAIL">Fail</option>
            <option value="UNCERTAIN">Uncertain</option>
          </select>
        </div>
        <div className="rp-filter-count">
          {loading ? 'Loading…' : `${scans.length} record${scans.length !== 1 ? 's' : ''}`}
        </div>
      </div>

      {/* ── Tab nav ── */}
      <div className="rp-tabs">
        {[
          { id: 'overview', label: 'Overview',     icon: <BarChart2  size={14}/> },
          { id: 'records',  label: 'Scan Records', icon: <FileText   size={14}/> },
          { id: 'batches',  label: 'Batches',      icon: <TrendingUp size={14}/> },
          { id: 'audit',    label: 'Audit Log',    icon: <CheckCircle size={14}/> },
        ].map(t => (
          <button key={t.id}
            className={`rp-tab ${tab === t.id ? 'rp-tab-active' : ''}`}
            onClick={() => setTab(t.id)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={tab}
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }}>

          {/* ═══ OVERVIEW ═══ */}
          {tab === 'overview' && (
            <div className="rp-overview">

              {/* KPI cards */}
              <div className="rp-kpi-row">
                <KPICard label="Total Scans"
                  value={stats?.total ?? scans.length}
                  sub="in selected range" accent="#3b82f6"/>
                <KPICard label="Pass Rate"
                  value={`${stats?.pass_rate ?? pct(scans.filter(s=>s.status==='PASS').length, scans.length)}%`}
                  sub={`${stats?.pass ?? scans.filter(s=>s.status==='PASS').length} passed`}
                  accent="#22c55e"/>
                <KPICard label="Fail Rate"
                  value={`${stats?.fail_rate ?? pct(scans.filter(s=>s.status==='FAIL').length, scans.length)}%`}
                  sub={`${stats?.fail ?? scans.filter(s=>s.status==='FAIL').length} failed`}
                  accent="#ef4444"/>
                <KPICard label="Avg Confidence"
                  value={`${stats?.avg_conf ?? (scans.length ? (scans.reduce((a,s)=>a+(s.confidence||0),0)/scans.length*100).toFixed(1) : 0)}%`}
                  sub="across all scans" accent="#8b5cf6"/>
                <KPICard label="Defect Rate"
                  value={`${stats?.defect_rate ?? '—'}%`}
                  sub="last 24 hours" accent="#f59e0b"/>
                <KPICard label="Throughput"
                  value={`${stats?.throughput_per_min ?? '—'}/min`}
                  sub="last 60 seconds" accent="#0ea5e9"/>
              </div>

              {/* Charts */}
              {scans.length === 0 && !loading ? (
                <div className="rp-empty">
                  <div className="rp-empty-icon">📊</div>
                  <div className="rp-empty-title">No reports yet</div>
                  <div className="rp-empty-sub">Run an inspection first — results will appear here.</div>
                </div>
              ) : (
                <div className="rp-charts-row">
                  <div className="rp-chart-card">
                    <div className="rp-chart-title"><TrendingUp size={15}/> Scans Over Time</div>
                    <ResponsiveContainer width="100%" height={230}>
                      <LineChart data={stats?.timeline || []} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0"/>
                        <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#94a3b8' }}/>
                        <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} allowDecimals={false}/>
                        <Tooltip content={<CustomTooltip/>}/>
                        <Line type="monotone" dataKey="pass"      name="Pass"      stroke="#22c55e" strokeWidth={2} dot={false}/>
                        <Line type="monotone" dataKey="fail"      name="Fail"      stroke="#ef4444" strokeWidth={2} dot={false}/>
                        <Line type="monotone" dataKey="uncertain" name="Uncertain" stroke="#f59e0b" strokeWidth={2} dot={false}/>
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="rp-chart-card rp-chart-card-sm">
                    <div className="rp-chart-title"><BarChart2 size={15}/> Status Distribution</div>
                    {pieData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={230}>
                        <PieChart>
                          <Pie data={pieData} cx="50%" cy="50%"
                            innerRadius={55} outerRadius={85}
                            paddingAngle={3} dataKey="value"
                            label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`}
                            labelLine={false}>
                            {pieData.map(entry => (
                              <Cell key={entry.name} fill={PIE_COLORS[entry.name]}/>
                            ))}
                          </Pie>
                          <Tooltip formatter={(v, n) => [v, n]}/>
                        </PieChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="rp-chart-empty">No data yet</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ═══ SCAN RECORDS ═══ */}
          {tab === 'records' && (
            <div className="rp-table-panel">
              {loading ? (
                <div className="rp-loading">
                  <div className="rp-loading-spinner"/> Loading records…
                </div>
              ) : sortedScans.length === 0 ? (
                <div className="rp-empty">
                  <div className="rp-empty-icon">🔍</div>
                  <div className="rp-empty-title">No records match your filters</div>
                  <div className="rp-empty-sub">Try adjusting the date range or status filter.</div>
                </div>
              ) : (
                <>
                  <div className="rp-table-wrap">
                    <table className="rp-table">
                      <thead>
                        <tr>
                          <th className="rp-th-sort" onClick={() => toggleSort('timestamp')}>
                            Timestamp <SortIcon col="timestamp"/>
                          </th>
                          <th>Product</th>
                          <th className="rp-th-sort" onClick={() => toggleSort('status')}>
                            Status <SortIcon col="status"/>
                          </th>
                          <th className="rp-th-sort" onClick={() => toggleSort('confidence')}>
                            Confidence <SortIcon col="confidence"/>
                          </th>
                          <th>Message</th>
                          <th>Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagedScans.map((s, i) => (
                          <tr key={i} className="rp-tr">
                            <td className="rp-td-mono">{s.timestamp}</td>
                            <td><span className="rp-product-chip">{s.product_type || '—'}</span></td>
                            <td><StatusBadge status={s.status}/></td>
                            <td><ConfBar value={s.confidence || 0}/></td>
                            <td className="rp-td-reason">{s.reason || '—'}</td>
                            <td>
                              <span className={`rp-source-chip${s.source === 'mobile' ? ' rp-source-chip--mobile' : ''}`}>
                                {s.source === 'mobile' ? '📡 Mobile' : s.source || 'camera'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {totalPages > 1 && (
                    <div className="rp-pagination">
                      <span className="rp-page-info">
                        Page {page + 1} of {totalPages} · {sortedScans.length} records
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="rp-page-btn" disabled={page === 0}
                          onClick={() => setPage(p => p - 1)}>← Prev</button>
                        <button className="rp-page-btn" disabled={page >= totalPages - 1}
                          onClick={() => setPage(p => p + 1)}>Next →</button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ═══ BATCHES ═══ */}
          {tab === 'batches' && (
            <div className="rp-table-panel">
              {batches.filter(b => b.endTime).length === 0 ? (
                <div className="rp-empty">
                  <div className="rp-empty-icon">📦</div>
                  <div className="rp-empty-title">No completed batches</div>
                  <div className="rp-empty-sub">Start and end a batch from the Inspect page.</div>
                </div>
              ) : (
                <div className="rp-table-wrap">
                  <table className="rp-table">
                    <thead>
                      <tr>
                        <th>Batch ID</th><th>Started</th><th>Ended</th>
                        <th>Scans</th><th>Defect Rate</th><th>Export</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batches.filter(b => b.endTime).reverse().map((b, i) => {
                        const rate = b.totalScans ? ((b.defects / b.totalScans) * 100).toFixed(1) : 0;
                        const dlBatch = (fmt) => {
                          const content = fmt === 'json' ? JSON.stringify(b, null, 2) : (() => {
                            let csv = 'Scan ID,Timestamp,Product Type,Status,Confidence\n';
                            (b.scans || []).forEach(s => {
                              csv += `${s.scanId},${s.timestamp},${s.productType||''},${s.status},${((s.confidence||0)*100).toFixed(1)}%\n`;
                            });
                            return csv;
                          })();
                          const blob = new Blob([content], { type: fmt === 'json' ? 'application/json' : 'text/csv' });
                          const a = document.createElement('a');
                          a.href = URL.createObjectURL(blob);
                          a.download = `batch_${b.id}.${fmt}`;
                          a.click();
                        };
                        return (
                          <tr key={i} className="rp-tr">
                            <td><span className="rp-batch-id">{b.id}</span></td>
                            <td className="rp-td-mono">{b.startTime}</td>
                            <td className="rp-td-mono">{b.endTime}</td>
                            <td>{b.totalScans}<span className="rp-td-muted"> ({b.defects} defects)</span></td>
                            <td>
                              <span style={{ color: rate > 10 ? '#ef4444' : rate > 0 ? '#f59e0b' : '#22c55e', fontWeight: 700 }}>
                                {rate}%
                              </span>
                            </td>
                            <td>
                              <div className="rp-dl-group">
                                <button className="rp-dl-btn" onClick={() => dlBatch('csv')}><Download size={11}/> CSV</button>
                                <button className="rp-dl-btn" onClick={() => dlBatch('json')}><Download size={11}/> JSON</button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ═══ AUDIT LOG ═══ */}
          {tab === 'audit' && (
            <div className="rp-table-panel">
              {auditLogs.length === 0 ? (
                <div className="rp-empty">
                  <div className="rp-empty-icon">📋</div>
                  <div className="rp-empty-title">No audit logs recorded</div>
                  <div className="rp-empty-sub">System events will appear here as the platform runs.</div>
                </div>
              ) : (
                <div className="rp-table-wrap">
                  <table className="rp-table">
                    <thead><tr><th>Timestamp</th><th>Event</th><th>Details</th></tr></thead>
                    <tbody>
                      {auditLogs.map((log, i) => (
                        <tr key={i} className="rp-tr">
                          <td className="rp-td-mono">{log.timestamp}</td>
                          <td><span className="rp-event-chip">{(log.type || '').replace(/_/g, ' ')}</span></td>
                          <td className="rp-td-reason">{typeof log.details === 'string' ? log.details : 'System event'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

        </motion.div>
      </AnimatePresence>

    </div>
  );
};

export default ReportsPage;
