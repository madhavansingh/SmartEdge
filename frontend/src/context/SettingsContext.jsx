import { createContext, useContext, useState, useEffect } from 'react';

const SettingsContext = createContext();

// eslint-disable-next-line react-refresh/only-export-components
export const useSettings = () => useContext(SettingsContext);

const DEFAULTS = {
  defaultProduct:      'PCB',
  autoScanInterval:    3,       // seconds
  liveScanEnabled:     true,
  resolution:          'medium',
  voiceFeedback:       true,
  voiceVolume:         80,      // 0–100
  confidenceThreshold: 70,      // 0–100
  alertsEnabled:       true,
};

const STORAGE_KEY = 'smartedge_settings';

const load = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch { return { ...DEFAULTS }; }
};

export const SettingsProvider = ({ children }) => {
  const [settings, setSettings] = useState(load);

  // Persist on every change
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
    catch { /* ignore quota errors */ }
  }, [settings]);

  const update = (key, value) =>
    setSettings(prev => ({ ...prev, [key]: value }));

  const reset = () => setSettings({ ...DEFAULTS });

  return (
    <SettingsContext.Provider value={{ settings, update, reset }}>
      {children}
    </SettingsContext.Provider>
  );
};
