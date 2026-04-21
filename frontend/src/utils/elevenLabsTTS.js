/**
 * elevenLabsTTS.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared TTS utility that plays text using ElevenLabs voice (ID: 3jR9BuQAOPMWUjWpi0ll)
 * via the backend /tts proxy endpoint.
 *
 * Falls back gracefully to browser SpeechSynthesis if the backend is not
 * configured (ELEVENLABS_API_KEY missing) or if the request fails.
 */

const API_BASE = '/api';

// Track current audio to allow cancellation
let _currentAudio = null;

/**
 * Cancel any currently playing TTS audio.
 */
export const cancelSpeak = () => {
  if (_currentAudio) {
    _currentAudio.pause();
    _currentAudio.src = '';
    _currentAudio = null;
  }
  // Also cancel browser fallback
  try { window.speechSynthesis?.cancel(); } catch (_) {}
};

/**
 * Speak text using ElevenLabs (via backend proxy).
 * Falls back to browser SpeechSynthesis on failure.
 *
 * @param {string} text   - The text to speak
 * @param {object} opts   - Optional: { onStart, onEnd, onError }
 * @returns {Promise<void>}
 */
export const speakText = async (text, opts = {}) => {
  if (!text || !text.trim()) return;

  // Cancel previous
  cancelSpeak();

  const { onStart, onEnd, onError } = opts;

  try {
    const res = await fetch(`${API_BASE}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim() }),
    });

    if (!res.ok) {
      // ElevenLabs not configured — fall back to browser TTS silently
      _browserFallback(text);
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    _currentAudio = audio;

    audio.onplay  = () => onStart?.();
    audio.onended = () => {
      URL.revokeObjectURL(url);
      _currentAudio = null;
      onEnd?.();
    };
    audio.onerror = (e) => {
      URL.revokeObjectURL(url);
      _currentAudio = null;
      onError?.(e);
      _browserFallback(text);
    };

    await audio.play();
  } catch (err) {
    console.warn('[TTS] ElevenLabs failed, using browser fallback:', err?.message);
    onError?.(err);
    _browserFallback(text);
  }
};

/**
 * Browser SpeechSynthesis fallback.
 */
function _browserFallback(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 1.05; utt.pitch = 1; utt.volume = 1;
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v => v.lang.startsWith('en') && v.localService);
    if (preferred) utt.voice = preferred;
    window.speechSynthesis.speak(utt);
  } catch (_) {}
}
