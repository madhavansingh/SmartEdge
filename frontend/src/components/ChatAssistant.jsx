import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageCircle, X, Send, Mic, MicOff, Bot, User, Volume2 } from 'lucide-react';
import { speakText, cancelSpeak } from '../utils/elevenLabsTTS';
import './ChatAssistant.css';

const API_BASE = '/api';  // Vite proxy → localhost:8000 (works from phone too)

// ── Suggested starters ────────────────────────────────────────────────────
const STARTERS = [
  'What was the last scan result?',
  'How many failures today?',
  'What is the pass rate?',
  'Any PCB defects detected?',
];

const ChatAssistant = () => {
  const [open, setOpen]         = useState(false);
  const [messages, setMessages] = useState([
    { role: 'bot', text: 'Hi! I\'m SmartEdge AI. Ask me anything about your inspections.' }
  ]);
  const [input, setInput]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [speaking, setSpeaking] = useState(false);

  const bottomRef    = useRef(null);
  const inputRef     = useRef(null);
  const recognizerRef = useRef(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Focus input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 150);
  }, [open]);

  // ── Send message ─────────────────────────────────────────────────────────
  const sendMessage = async (text) => {
    const q = (text || input).trim();
    if (!q || loading) return;

    setInput('');
    setMessages(prev => [...prev, { role: 'user', text: q }]);
    setLoading(true);

    try {
      const res  = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      const answer = data.answer || 'I couldn\'t get a response. Please try again.';
      setMessages(prev => [...prev, { role: 'bot', text: answer }]);
      if (voiceEnabled) {
        setSpeaking(true);
        speakText(answer, {
          onStart: () => setSpeaking(true),
          onEnd:   () => setSpeaking(false),
          onError: () => setSpeaking(false),
        });
      }
    } catch (_) {
      setMessages(prev => [...prev, { role: 'bot', text: 'Assistant unavailable, try again.', error: true }]);
    } finally {
      setLoading(false);
    }
  };

  // ── Voice input (Web Speech API) ─────────────────────────────────────────
  const toggleVoice = () => {
    if (listening) {
      recognizerRef.current?.stop();
      setListening(false);
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Speech recognition not supported in this browser.'); return; }

    const rec = new SR();
    rec.lang = 'en-US';
    rec.continuous = false;
    rec.interimResults = false;

    rec.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      setInput(transcript);
      setListening(false);
    };
    rec.onerror = () => setListening(false);
    rec.onend   = () => setListening(false);

    rec.start();
    recognizerRef.current = rec;
    setListening(true);
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  return (
    <>
      {/* ── Floating trigger button ── */}
      <motion.button
        className="chat-fab"
        onClick={() => setOpen(v => !v)}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.95 }}
        aria-label="Open inspection assistant"
      >
        <AnimatePresence mode="wait">
          {open
            ? <motion.span key="x"  initial={{rotate:-90,opacity:0}} animate={{rotate:0,opacity:1}} exit={{rotate:90,opacity:0}}><X size={22}/></motion.span>
            : <motion.span key="mc" initial={{rotate:90,opacity:0}}  animate={{rotate:0,opacity:1}} exit={{rotate:-90,opacity:0}}><MessageCircle size={22}/></motion.span>
          }
        </AnimatePresence>
        {/* unread dot when closed */}
        {!open && <span className="chat-fab-dot" />}
      </motion.button>

      {/* ── Chat panel ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="chat-panel"
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0,  scale: 1    }}
            exit={{    opacity: 0, y: 24, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 340, damping: 28 }}
          >
            {/* Header */}
            <div className="chat-header">
              <div className="chat-header-left">
                <div className="chat-avatar-sm">
                  <Bot size={15} />
                </div>
                <div>
                  <div className="chat-header-name">SmartEdge AI</div>
                  <div className="chat-header-status">
                    <span className="chat-status-dot" /> Inspection Assistant
                  </div>
                </div>
              </div>
              <div className="chat-header-actions">
                <button
                  className={`chat-icon-btn ${voiceEnabled ? 'chat-icon-btn-active' : ''}`}
                  onClick={() => {
                    const next = !voiceEnabled;
                    setVoiceEnabled(next);
                    if (!next) { cancelSpeak(); setSpeaking(false); }
                  }}
                  title={voiceEnabled ? 'Mute ElevenLabs voice' : 'Unmute ElevenLabs voice'}
                >
                  {voiceEnabled
                    ? <span style={{ display:'flex', alignItems:'center', gap:3 }}>
                        <Volume2 size={13}/>
                        {speaking && <span className="chat-speaking-dot" />}
                      </span>
                    : '🔇'}
                </button>
                <button className="chat-icon-btn" onClick={() => { setOpen(false); cancelSpeak(); setSpeaking(false); }}>
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="chat-messages">
              {messages.map((msg, i) => (
                <motion.div
                  key={i}
                  className={`chat-bubble-wrap ${msg.role}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  {msg.role === 'bot' && (
                    <div className="chat-bot-icon"><Bot size={13}/></div>
                  )}
                  <div className={`chat-bubble ${msg.role} ${msg.error ? 'chat-bubble-error' : ''}`}>
                    {msg.text}
                  </div>
                  {msg.role === 'user' && (
                    <div className="chat-user-icon"><User size={13}/></div>
                  )}
                </motion.div>
              ))}

              {/* Typing indicator */}
              {loading && (
                <motion.div className="chat-bubble-wrap bot" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <div className="chat-bot-icon"><Bot size={13}/></div>
                  <div className="chat-bubble bot chat-typing">
                    <span /><span /><span />
                  </div>
                </motion.div>
              )}

              <div ref={bottomRef} />
            </div>

            {/* Starters (only when 1 message = initial greeting) */}
            {messages.length === 1 && (
              <div className="chat-starters">
                {STARTERS.map(s => (
                  <button key={s} className="chat-starter-btn" onClick={() => sendMessage(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}

            {/* Input row */}
            <div className="chat-input-row">
              <button
                className={`chat-mic-btn ${listening ? 'chat-mic-active' : ''}`}
                onClick={toggleVoice}
                title={listening ? 'Stop listening' : 'Speak your question'}
              >
                {listening ? <MicOff size={16}/> : <Mic size={16}/>}
              </button>

              <input
                ref={inputRef}
                className="chat-input"
                placeholder={listening ? 'Listening…' : 'Ask about your scans…'}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKey}
                disabled={loading}
              />

              <button
                className="chat-send-btn"
                onClick={() => sendMessage()}
                disabled={!input.trim() || loading}
                title="Send"
              >
                <Send size={16}/>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default ChatAssistant;
