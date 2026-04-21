/**
 * Lightweight Toast System — no external deps
 * Usage: import { toast } from '../utils/toast';
 *        toast.success('Report downloaded');
 *        toast.error('Upload failed');
 *        toast.info('Scanning…');
 */

let _container = null;

function getContainer() {
  if (!_container) {
    _container = document.getElementById('toast-portal');
    if (!_container) {
      _container = document.createElement('div');
      _container.id = 'toast-portal';
      document.body.appendChild(_container);
    }
  }
  return _container;
}

const ICONS = {
  success: '✓',
  error:   '✕',
  info:    'ℹ',
};

function show(message, type = 'info', duration = 3200) {
  const container = getContainer();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `
    <span style="font-size:14px;font-weight:700;">${ICONS[type] ?? ICONS.info}</span>
    <span>${message}</span>
  `;
  container.appendChild(el);

  const dismiss = () => {
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };

  const timer = setTimeout(dismiss, duration);
  el.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
}

export const toast = {
  success: (msg, dur) => show(msg, 'success', dur),
  error:   (msg, dur) => show(msg, 'error', dur),
  info:    (msg, dur) => show(msg, 'info', dur),
};
