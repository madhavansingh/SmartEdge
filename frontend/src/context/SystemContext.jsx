import { createContext, useState, useContext, useEffect } from 'react';

const SystemContext = createContext();

// eslint-disable-next-line react-refresh/only-export-components
export const useSystem = () => useContext(SystemContext);

export const SystemProvider = ({ children }) => {
  // Load initial state from memory/localStorage if desired, but we'll use memory for now
  const [totalScans, setTotalScans] = useState(0);
  const [defectsDetected, setDefectsDetected] = useState(0);
  const [latestScan, setLatestScan] = useState(null);
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [systemActive] = useState(true);
  
  // New production features state
  const [isOperatorMode, setIsOperatorMode] = useState(false);
  const [currentBatchId, setCurrentBatchId] = useState(null);
  const [batches, setBatches] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [scanHistory, setScanHistory] = useState([]);
  const [isDemoMode, setIsDemoMode] = useState(false);

  // Generate a random ID
  const generateId = (prefix) => `${prefix}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
  const getTimestamp = () => new Date().toLocaleString();

  const addAuditLog = (type, details) => {
    setAuditLogs(prev => [{
      id: generateId('LOG'),
      timestamp: getTimestamp(),
      type,
      details
    }, ...prev]);
  };

  const startBatch = (customId = null) => {
    const newBatchId = customId || generateId('BCH');
    setCurrentBatchId(newBatchId);
    setBatches(prev => [...prev, { id: newBatchId, startTime: getTimestamp(), endTime: null, totalScans: 0, defects: 0, scans: [] }]);
    addAuditLog('BATCH_STARTED', `Batch ${newBatchId} initialized`);
  };

  const endBatch = () => {
    if (currentBatchId) {
      setBatches(prev => prev.map(b => b.id === currentBatchId ? { ...b, endTime: getTimestamp() } : b));
      addAuditLog('BATCH_ENDED', `Batch ${currentBatchId} completed`);
      setCurrentBatchId(null);
    }
  };

  const addScan = (result) => {
    const isFail = result.status === 'FAIL';
    
    setTotalScans(prev => prev + 1);
    if (isFail) setDefectsDetected(prev => prev + 1);
    setLatestScan(result);
    setScanHistory(prev => [result, ...prev]);

    // Update current batch stats
    if (currentBatchId) {
      setBatches(prev => prev.map(b => {
        if (b.id === currentBatchId) {
          return { ...b, totalScans: b.totalScans + 1, defects: b.defects + (isFail ? 1 : 0), scans: [result, ...b.scans] };
        }
        return b;
      }));
    }

    addAuditLog('SCAN_COMPLETED', `Scan ${result.scanId} completed. Status: ${result.status}`);
    if (isFail && result.defects?.some(d => d.confidence > 0.85)) {
      addAuditLog('CRITICAL_ALERT', `Critical defect detected in ${result.scanId}`);
    }

    // Persist to backend store (fire-and-forget) — uses Vite proxy so it works
    // from both the laptop browser and indirectly via the MobileQRPanel polling.
    fetch('/api/report-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp:    result.timestamp,
        product_type: result.productType || result.product_type || 'Unknown',
        status:       result.status,
        confidence:   result.confidence ?? 0,
        reason:       result.reason || result.message || '',
        scanId:       result.scanId || '',
        source:       result.source || 'camera',
      }),
    }).catch(() => { /* silently ignore network errors */ });
  };

  const defectRate = totalScans > 0 ? ((defectsDetected / totalScans) * 100).toFixed(1) : 0;
  const yieldRate = totalScans > 0 ? (100 - defectRate).toFixed(1) : 100;

  // Calculate system confidence based on last 20 scans (dummy logic: average confidence or base 98%)
  const systemConfidence = scanHistory.length > 0 
    ? (scanHistory.slice(0, 20).reduce((acc, scan) => acc + (scan.status === 'PASS' ? 99 : (100 - (scan.defects?.[0]?.confidence || 0.8) * 100)), 0) / Math.min(scanHistory.length, 20)).toFixed(1)
    : 99.5;

  return (
    <SystemContext.Provider value={{
      totalScans,
      defectsDetected,
      defectRate,
      yieldRate,
      latestScan,
      addScan,
      isLiveMode,
      setIsLiveMode,
      systemActive,
      isOperatorMode,
      setIsOperatorMode,
      currentBatchId,
      batches,
      startBatch,
      endBatch,
      auditLogs,
      addAuditLog,
      scanHistory,
      systemConfidence,
      isDemoMode,
      setIsDemoMode
    }}>
      {children}
    </SystemContext.Provider>
  );
};
