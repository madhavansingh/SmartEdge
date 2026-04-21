import { useNavigate, Link } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { motion, useScroll, useTransform, useInView, AnimatePresence } from 'framer-motion';
import {
  Cpu, Camera, BarChart2, FileText, Mic2, Shield, Zap, Package,
  ChevronRight, ArrowRight, Check, Star, Play, Upload, Activity,
  CheckCircle2, AlertCircle, HelpCircle, Download, Settings, Menu, X, User, LogOut
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './LandingPage.css';

/* ─── Nav links ──────────────────────────────────────────────────────────── */
const NAV_LINKS = [
  { label: 'Features',  href: '#features' },
  { label: 'Workflow',  href: '#workflow'  },
  { label: 'Inspect',   href: '/inspect',  isRoute: true },
  { label: 'Reports',   href: '/reports',  isRoute: true },
];

/* ─── Feature data ───────────────────────────────────────────────────────── */
const FEATURES = [
  { icon: Camera,    title: 'Real-Time Inspection',      desc: 'Stream live camera frames directly into the inspection pipeline — no separate software needed.', tag: 'LIVE' },
  { icon: Package,   title: 'Multi-Product Support',     desc: 'Switch between PCB boards, Parle-G biscuits, and automotive parts without any reconfiguration.', tag: 'FLEXIBLE' },
  { icon: Upload,    title: 'Image Upload Mode',         desc: 'Upload a JPG or PNG for offline batch analysis using the same computer vision pipeline.', tag: 'BATCH' },
  { icon: BarChart2, title: 'Analytics Dashboard',       desc: 'KPI cards, trend charts, and product breakdowns update automatically after every scan.', tag: 'ANALYTICS' },
  { icon: FileText,  title: 'Exportable Reports',        desc: 'One-click CSV download with timestamp, product, status, confidence, and reason columns.', tag: 'REPORTS' },
  { icon: Shield,    title: 'Operator Confidence',       desc: 'Majority-voting across frames, confidence flooring, and canonical reason strings keep results stable.', tag: 'RELIABLE' },
  { icon: Mic2,      title: 'Voice Announcements',       desc: 'PASS / FAIL results are spoken aloud in real time — hands-free quality monitoring.', tag: 'VOICE' },
  { icon: Zap,       title: 'OpenCV-First Pipeline',     desc: 'Domain classification and CV analysis run locally before any cloud call — fast and cost-efficient.', tag: 'FAST' },
];

/* ─── Inspection types ───────────────────────────────────────────────────── */
const INSPECTION_TYPES = [
  {
    icon: '🔌',
    label: 'PCB INSPECTION',
    title: 'Printed Circuit Board Analysis',
    detects: 'Missing components, solder bridges, broken traces, incorrect placement',
    why: 'A single faulty PCB in production can cause downstream device failure. Automated visual inspection catches defects before they leave the line.',
    result: 'PASS / FAIL with component-level defect classification and confidence score.',
    color: '#3b82f6',
  },
  {
    icon: '🍪',
    label: 'BISCUIT INSPECTION',
    title: 'Parle-G Biscuit Quality Check',
    detects: 'Broken edges, shape deformations, missing sections, aspect-ratio deviations',
    why: 'Food-grade inspection requires fast, consistent evaluation across hundreds of units per minute — impossible to do reliably by hand.',
    result: 'PASS / FAIL based on geometric shape analysis, solidity score, and color range.',
    color: '#f59e0b',
  },
  {
    icon: '🚗',
    label: 'AUTOMOTIVE INSPECTION',
    title: 'Automotive Part Defect Detection',
    detects: 'Dents, cracks, surface damage, missing welds, structural anomalies',
    why: 'Safety-critical parts demand zero tolerance for structural defects. Vision-based inspection flags issues that manual checks routinely miss.',
    result: 'PASS / FAIL driven by object detection with per-region confidence scoring.',
    color: '#10b981',
  },
];

/* ─── Workflow steps ─────────────────────────────────────────────────────── */
const WORKFLOW_STEPS = [
  { n: '01', title: 'Select Product',     desc: 'Choose the inspection category: PCB, Biscuit, or Automotive.' },
  { n: '02', title: 'Capture or Upload',  desc: 'Point the camera or drop an image file into the upload zone.' },
  { n: '03', title: 'AI Analysis',        desc: 'The vision pipeline classifies the domain and runs the appropriate CV model.' },
  { n: '04', title: 'Review Result',      desc: 'PASS / FAIL / UNCERTAIN appears instantly with confidence and reason.' },
  { n: '05', title: 'Export Report',      desc: 'Download a filtered CSV with complete scan history for QA records.' },
];

/* ─── Benefits ───────────────────────────────────────────────────────────── */
const BENEFITS = [
  { label: 'Reduces manual inspection labour by automating repetitive visual checks.' },
  { label: 'Improves consistency — the same standard applied to every unit, every time.' },
  { label: 'Helps operators make faster go/no-go decisions with clear, confident results.' },
  { label: 'Generates structured quality records automatically after every scan.' },
  { label: 'Supports multiple manufacturing domains without separate tools.' },
  { label: 'Works in real time and in batch upload mode for flexible deployment.' },
];

/* ─── Animation helpers ──────────────────────────────────────────────────── */
const fadeUp = (delay = 0) => ({
  initial:   { opacity: 0, y: 28 },
  whileInView: { opacity: 1, y: 0 },
  viewport:  { once: true, amount: 0.2 },
  transition: { duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] },
});

const stagger = (i, base = 0.1) => fadeUp(i * base);

/* ════════════════════════════════════════════════════════════════════════════
   Navbar
   ════════════════════════════════════════════════════════════════════════════ */
const Navbar = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen]  = useState(false);
  const [avatarError, setAvatarError] = useState(false);

  useEffect(() => {
    return scrollY.on('change', v => setScrolled(v > 30));
  }, [scrollY]);

  const scrollTo = (href) => {
    setMenuOpen(false);
    if (href.startsWith('/')) { navigate(href); return; }
    const el = document.querySelector(href);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <motion.nav
      className={`lp-nav ${scrolled ? 'lp-nav-scrolled' : ''}`}
      initial={{ y: -80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="lp-nav-inner">
        {/* Logo */}
        <button className="lp-nav-logo" onClick={() => scrollTo('#top')}>
          <div className="lp-nav-logo-icon"><Cpu size={18} /></div>
          <span className="lp-nav-logo-text">SmartEdge<span>AI</span></span>
        </button>

        {/* Desktop links */}
        <div className="lp-nav-links">
          {NAV_LINKS.map(l => (
            <button key={l.label} className="lp-nav-link" onClick={() => scrollTo(l.href)}>
              {l.label}
            </button>
          ))}
        </div>

        {/* Desktop CTAs */}
        <div className="lp-nav-ctas">
          {user ? (
            <>
              <div className="lp-nav-user">
                {user.picture && !avatarError ? (
                  <img src={user.picture} alt={user.name} className="lp-nav-avatar"
                    onError={() => setAvatarError(true)} referrerPolicy="no-referrer" />
                ) : (
                  <div className="lp-nav-avatar-fallback">{user.name?.[0] || <User size={14}/>}</div>
                )}
                <span className="lp-nav-username">{user.name?.split(' ')[0]}</span>
              </div>
              <button className="lp-btn-ghost" onClick={() => navigate('/dashboard')}>Dashboard</button>
              <button className="lp-btn-primary" onClick={() => navigate('/inspect')}>
                Inspect <ArrowRight size={14}/>
              </button>
              <button className="lp-nav-logout" onClick={async () => { await logout(); }} title="Sign out">
                <LogOut size={15}/>
              </button>
            </>
          ) : (
            <>
              <button className="lp-btn-ghost" onClick={() => navigate('/login')}>Login</button>
              <button className="lp-btn-primary" onClick={() => navigate('/inspect')}>
                Start Inspection <ArrowRight size={14}/>
              </button>
            </>
          )}
        </div>

        {/* Hamburger */}
        <button className="lp-hamburger" onClick={() => setMenuOpen(v => !v)}>
          {menuOpen ? <X size={20}/> : <Menu size={20}/>}
        </button>
      </div>

      {/* Mobile menu */}
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            className="lp-mobile-menu"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
          >
            {NAV_LINKS.map(l => (
              <button key={l.label} className="lp-mobile-link" onClick={() => scrollTo(l.href)}>
                {l.label}
              </button>
            ))}
            <button className="lp-btn-primary lp-mobile-cta" onClick={() => { navigate('/inspect'); setMenuOpen(false); }}>
              Start Inspection <ArrowRight size={14}/>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.nav>
  );
};

/* ════════════════════════════════════════════════════════════════════════════
   Hero Section
   ════════════════════════════════════════════════════════════════════════════ */
const HeroSection = () => {
  const navigate = useNavigate();
  const ref = useRef(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], ['0%', '18%']);

  return (
    <section className="lp-hero" id="top" ref={ref}>
      {/* Gradient background blobs */}
      <motion.div className="lp-hero-blob lp-hero-blob1" style={{ y }} />
      <motion.div className="lp-hero-blob lp-hero-blob2" style={{ y }} />
      <div className="lp-hero-grid-overlay" />

      <div className="lp-container lp-hero-inner">
        {/* Left: copy */}
        <div className="lp-hero-copy">
          <motion.div className="lp-hero-badge" {...fadeUp(0.1)}>
            <span className="lp-hero-badge-dot" />
            Computer Vision · Industrial QA · Real-Time
          </motion.div>

          <motion.h1 className="lp-hero-h1" {...fadeUp(0.2)}>
            AI-Powered Inspection<br />
            <span className="lp-gradient-text">for Smart Manufacturing</span>
          </motion.h1>

          <motion.p className="lp-hero-sub" {...fadeUp(0.3)}>
            SmartEdge AI Inspector automates quality control for PCB boards, food products, and automotive parts
            using camera-based computer vision, structured analytics, and instant operator feedback.
          </motion.p>

          <motion.div className="lp-hero-ctas" {...fadeUp(0.4)}>
            <button className="lp-btn-primary lp-btn-lg" onClick={() => navigate('/inspect')}>
              Start Inspection <ArrowRight size={16}/>
            </button>
            <button className="lp-btn-outline lp-btn-lg" onClick={() => document.querySelector('#workflow')?.scrollIntoView({ behavior: 'smooth' })}>
              <Play size={15}/> See How It Works
            </button>
          </motion.div>

          <motion.p className="lp-hero-trust" {...fadeUp(0.5)}>
            <CheckCircle2 size={14}/> Built for real factory workflows, operator speed, and quality control teams.
          </motion.p>
        </div>

        {/* Right: visual mockup */}
        <motion.div
          className="lp-hero-visual"
          initial={{ opacity: 0, x: 40 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Main glass card */}
          <div className="lp-hero-card lp-hero-card-main">
            <div className="lp-hero-card-header">
              <div className="lp-hc-dot lp-hc-dot-r"/><div className="lp-hc-dot lp-hc-dot-y"/><div className="lp-hc-dot lp-hc-dot-g"/>
              <span className="lp-hc-title">INSPECTION RESULT</span>
            </div>
            <div className="lp-hc-body">
              <div className="lp-hc-status lp-hc-pass">
                <CheckCircle2 size={32}/>
                <span>PASS</span>
              </div>
              <div className="lp-hc-meta">
                <div className="lp-hc-row"><span>Product</span><span>PCB Board</span></div>
                <div className="lp-hc-row"><span>Confidence</span><span className="lp-hc-conf">91.4%</span></div>
                <div className="lp-hc-row"><span>Reason</span><span>No visible defect</span></div>
              </div>
              <div className="lp-hc-bar-wrap">
                <div className="lp-hc-bar-track"><div className="lp-hc-bar-fill" style={{ width: '91%' }}/></div>
              </div>
            </div>
          </div>

          {/* Floating card 1 — scan count */}
          <motion.div
            className="lp-hero-card lp-hero-chip lp-chip-top"
            animate={{ y: [0, -7, 0] }}
            transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
          >
            <Activity size={14}/> <strong>1,284</strong> scans today
          </motion.div>

          {/* Floating card 2 — pass rate */}
          <motion.div
            className="lp-hero-card lp-hero-chip lp-chip-bottom"
            animate={{ y: [0, 7, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut', delay: 0.8 }}
          >
            <CheckCircle2 size={14}/> <strong>97.2%</strong> pass rate
          </motion.div>

          {/* Floating card 3 — domain */}
          <motion.div
            className="lp-hero-card lp-hero-chip lp-chip-left"
            animate={{ x: [0, -5, 0] }}
            transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut', delay: 1.2 }}
          >
            <Package size={14}/> 3 product types
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
};

/* ════════════════════════════════════════════════════════════════════════════
   Features Section
   ════════════════════════════════════════════════════════════════════════════ */
const FeaturesSection = () => (
  <section className="lp-section lp-features-section" id="features">
    <div className="lp-container">
      <motion.div className="lp-section-header" {...fadeUp()}>
        <span className="lp-section-eyebrow">CAPABILITIES</span>
        <h2 className="lp-section-h2">Everything a quality team needs</h2>
        <p className="lp-section-sub">
          From live camera inspection to exportable reports — a complete pipeline, purpose-built for manufacturing QA.
        </p>
      </motion.div>

      <div className="lp-features-grid">
        {FEATURES.map((f, i) => (
          <motion.div key={f.title} className="lp-feature-card" {...stagger(i, 0.07)}>
            <div className="lp-fc-icon-wrap">
              <f.icon size={20}/>
            </div>
            <span className="lp-fc-tag">{f.tag}</span>
            <h3 className="lp-fc-title">{f.title}</h3>
            <p className="lp-fc-desc">{f.desc}</p>
          </motion.div>
        ))}
      </div>
    </div>
  </section>
);

/* ════════════════════════════════════════════════════════════════════════════
   How It Works section
   ════════════════════════════════════════════════════════════════════════════ */
const HowItWorksSection = () => {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: 0.2 });

  const steps = [
    { icon: '🎯', title: 'Select product type', body: 'The operator picks PCB, Biscuit, or Automotive from the Inspect page. This primes the domain classifier.' },
    { icon: '📷', title: 'Capture or upload',   body: 'Either point a webcam at the item or drag-and-drop an image file. Both paths feed the same pipeline.' },
    { icon: '🧠', title: 'Vision analysis',     body: 'OpenCV classifies the domain locally. A specialised model runs defect detection. Gemini handles edge cases.' },
    { icon: '✅', title: 'Instant result',      body: 'PASS, FAIL, or UNCERTAIN appears with a confidence score and human-readable reason string.' },
    { icon: '📊', title: 'Dashboard updates',   body: 'Every result is logged automatically. Charts and KPIs on the dashboard refresh in real time.' },
    { icon: '📄', title: 'Export report',        body: 'The Reports page lets you filter by product or status and download a clean CSV for QA records.' },
  ];

  return (
    <section className="lp-section lp-howitworks" ref={ref}>
      <div className="lp-container">
        <motion.div className="lp-section-header" {...fadeUp()}>
          <span className="lp-section-eyebrow">HOW IT WORKS</span>
          <h2 className="lp-section-h2">Simple for operators. Powerful under the hood.</h2>
          <p className="lp-section-sub">
            The full inspection cycle takes seconds — from image input to dashboard record.
          </p>
        </motion.div>

        <div className="lp-how-grid">
          {steps.map((s, i) => (
            <motion.div
              key={i}
              className="lp-how-card"
              initial={{ opacity: 0, y: 24 }}
              animate={inView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.55, delay: i * 0.09, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="lp-how-num">{String(i + 1).padStart(2, '0')}</div>
              <div className="lp-how-emoji">{s.icon}</div>
              <h3 className="lp-how-title">{s.title}</h3>
              <p className="lp-how-body">{s.body}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

/* ════════════════════════════════════════════════════════════════════════════
   Inspection Types
   ════════════════════════════════════════════════════════════════════════════ */
const InspectionTypesSection = () => (
  <section className="lp-section lp-types-section">
    <div className="lp-container">
      <motion.div className="lp-section-header" {...fadeUp()}>
        <span className="lp-section-eyebrow">SUPPORTED DOMAINS</span>
        <h2 className="lp-section-h2">Three inspection pipelines. One platform.</h2>
        <p className="lp-section-sub">
          Each domain has its own specialised computer vision model, tuned for its unique defect profile.
        </p>
      </motion.div>

      <div className="lp-types-grid">
        {INSPECTION_TYPES.map((t, i) => (
          <motion.div key={t.label} className="lp-type-card" {...stagger(i, 0.12)} style={{ '--tc': t.color }}>
            <div className="lp-type-emoji">{t.icon}</div>
            <span className="lp-type-tag" style={{ color: t.color, borderColor: `${t.color}40`, background: `${t.color}10` }}>
              {t.label}
            </span>
            <h3 className="lp-type-title">{t.title}</h3>
            <dl className="lp-type-dl">
              <dt>DETECTS</dt>
              <dd>{t.detects}</dd>
              <dt>WHY IT MATTERS</dt>
              <dd>{t.why}</dd>
              <dt>RESULT</dt>
              <dd>{t.result}</dd>
            </dl>
          </motion.div>
        ))}
      </div>
    </div>
  </section>
);

/* ════════════════════════════════════════════════════════════════════════════
   Workflow Timeline
   ════════════════════════════════════════════════════════════════════════════ */
const WorkflowSection = () => {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: 0.15 });

  return (
    <section className="lp-section lp-workflow-section" id="workflow" ref={ref}>
      <div className="lp-container">
        <motion.div className="lp-section-header" {...fadeUp()}>
          <span className="lp-section-eyebrow">WORKFLOW</span>
          <h2 className="lp-section-h2">From image to insight in five steps</h2>
        </motion.div>

        <div className="lp-timeline">
          {WORKFLOW_STEPS.map((s, i) => (
            <motion.div
              key={s.n}
              className="lp-tl-item"
              initial={{ opacity: 0, x: -24 }}
              animate={inView ? { opacity: 1, x: 0 } : {}}
              transition={{ duration: 0.55, delay: i * 0.1, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="lp-tl-line">
                <div className="lp-tl-dot"/>
                {i < WORKFLOW_STEPS.length - 1 && <div className="lp-tl-connector"/>}
              </div>
              <div className="lp-tl-body">
                <span className="lp-tl-num">{s.n}</span>
                <h4 className="lp-tl-title">{s.title}</h4>
                <p className="lp-tl-desc">{s.desc}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

/* ════════════════════════════════════════════════════════════════════════════
   Benefits section
   ════════════════════════════════════════════════════════════════════════════ */
const BenefitsSection = () => (
  <section className="lp-section lp-benefits-section">
    <div className="lp-container lp-benefits-inner">
      <motion.div className="lp-benefits-copy" {...fadeUp()}>
        <span className="lp-section-eyebrow">BENEFITS</span>
        <h2 className="lp-section-h2" style={{ textAlign: 'left' }}>
          Built for industrial<br/>quality control teams
        </h2>
        <p className="lp-section-sub" style={{ textAlign: 'left', maxWidth: '400px' }}>
          SmartEdge AI Inspector replaces inconsistent manual checks with a reliable, fast, and operator-friendly pipeline.
        </p>
      </motion.div>
      <div className="lp-benefits-list">
        {BENEFITS.map((b, i) => (
          <motion.div key={i} className="lp-benefit-item" {...stagger(i, 0.08)}>
            <div className="lp-benefit-check"><Check size={14}/></div>
            <p>{b.label}</p>
          </motion.div>
        ))}
      </div>
    </div>
  </section>
);

/* ════════════════════════════════════════════════════════════════════════════
   CTA Section
   ════════════════════════════════════════════════════════════════════════════ */
const CTASection = () => {
  const navigate = useNavigate();
  return (
    <section className="lp-section lp-cta-section">
      <div className="lp-container">
        <motion.div className="lp-cta-card" {...fadeUp()}>
          <div className="lp-cta-blob"/>
          <span className="lp-section-eyebrow" style={{ color: '#93c5fd' }}>GET STARTED</span>
          <h2 className="lp-cta-h2">Ready to inspect smarter?</h2>
          <p className="lp-cta-sub">
            Connect a camera, select your product type, and get your first AI inspection result in under 30 seconds.
          </p>
          <div className="lp-cta-btns">
            <button className="lp-cta-btn-primary" onClick={() => navigate('/inspect')}>
              Start Inspection <ArrowRight size={16}/>
            </button>
            <button className="lp-cta-btn-ghost" onClick={() => navigate('/dashboard')}>
              View Live Demo
            </button>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

/* ════════════════════════════════════════════════════════════════════════════
   Footer
   ════════════════════════════════════════════════════════════════════════════ */
const Footer = () => {
  const navigate = useNavigate();
  return (
    <footer className="lp-footer">
      <div className="lp-container lp-footer-inner">
        <div className="lp-footer-brand">
          <div className="lp-footer-logo">
            <Cpu size={18}/> SmartEdge<span>AI</span>
          </div>
          <p className="lp-footer-tagline">
            Computer vision quality inspection for modern manufacturing — PCB, food, and automotive.
          </p>
        </div>

        <div className="lp-footer-links">
          <span className="lp-footer-col-label">PLATFORM</span>
          <button onClick={() => navigate('/dashboard')}>Dashboard</button>
          <button onClick={() => navigate('/inspect')}>Inspect</button>
          <button onClick={() => navigate('/reports')}>Reports</button>
        </div>

        <div className="lp-footer-links">
          <span className="lp-footer-col-label">INSPECTION</span>
          <button>PCB Boards</button>
          <button>Food / Biscuit</button>
          <button>Automotive Parts</button>
        </div>
      </div>

      <div className="lp-footer-bar">
        <span>© 2026 SmartEdge AI Inspector. Built for industrial quality control.</span>
      </div>
    </footer>
  );
};

/* ════════════════════════════════════════════════════════════════════════════
   Page Root
   ════════════════════════════════════════════════════════════════════════════ */
const LandingPage = () => (
  <div className="lp-root">
    <Navbar />
    <HeroSection />
    <FeaturesSection />
    <HowItWorksSection />
    <InspectionTypesSection />
    <WorkflowSection />
    <BenefitsSection />
    <CTASection />
    <Footer />
  </div>
);

export default LandingPage;
