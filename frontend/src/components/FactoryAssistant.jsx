import React, { useState, useRef, useEffect } from 'react';
import { Bot, Send, Terminal, AlertCircle } from 'lucide-react';
import { useSystem } from '../context/SystemContext';
import { generateReport } from '../utils/reportGenerator';
import './FactoryAssistant.css';

let nextId = 2;
const getTime = () => new Date().toLocaleTimeString();

const FactoryAssistant = () => {
  const { latestScan } = useSystem();
  
  const [messages, setMessages] = useState(() => [
    {
      id: 1,
      sender: 'assistant',
      text: 'FACTORY ASSISTANT ONLINE. Awaiting queries regarding inspection data.',
      timestamp: new Date().toLocaleTimeString()
    }
  ]);
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleQuery = (queryText) => {
    if (!queryText.trim()) return;

    // Add user message
    const userMsg = {
      id: nextId++,
      sender: 'user',
      text: queryText,
      timestamp: getTime()
    };
    
    setMessages(prev => [...prev, userMsg]);
    setInputValue('');

    // Simulate processing delay
    setTimeout(() => {
      generateResponse(queryText);
    }, 600);
  };

  const generateResponse = (query) => {
    const q = query.toLowerCase();
    
    let text = '';
    let structuredData = null;

    if (!latestScan) {
      text = "NO SCAN DATA AVAILABLE. Please execute an inspection run first.";
    } else if (latestScan.status === 'PASS') {
      text = "LATEST SCAN STATUS: PASS. No anomalies detected. System operating within optimal parameters.";
    } else {
      // We have a failing scan with defects
      const primaryDefect = latestScan.defects[0];
      const report = generateReport(primaryDefect.type);
      
      if (q.includes('explain') || q.includes('what')) {
        text = `ANALYSIS COMPLETE. Found anomaly: ${primaryDefect.type.toUpperCase()} (Confidence: ${(primaryDefect.confidence * 100).toFixed(1)}%)`;
        structuredData = {
          defect: primaryDefect.type.toUpperCase(),
          cause: "Detected visual anomaly matching known defect signatures in tensor database.",
          impact: report.impact
        };
      } else if (q.includes('suggest') || q.includes('fix') || q.includes('do')) {
        text = `RECOMMENDED ACTION PROTOCOL INITIATED.`;
        structuredData = {
          defect: primaryDefect.type.toUpperCase(),
          solution: report.recommendation,
          action: "Requires manual review by floor technician."
        };
      } else if (q.includes('critical')) {
        const isCritical = primaryDefect.confidence > 0.85;
        text = isCritical 
          ? `WARNING: Defect classified as CRITICAL (Confidence > 85%). Immediate line stoppage recommended.`
          : `NOTICE: Defect is non-critical, but requires logging for yield analysis.`;
      } else {
        text = `QUERY UNRECOGNIZED. Available commands: "Explain defect", "Suggest fix", "Is it critical?"`;
      }
    }

    const assistantMsg = {
      id: nextId++,
      sender: 'assistant',
      text,
      structuredData,
      timestamp: getTime()
    };

    setMessages(prev => [...prev, assistantMsg]);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleQuery(inputValue);
    }
  };

  return (
    <div className="factory-assistant panel">
      <div className="assistant-header flex-center-between mb-4">
        <div className="flex-center">
          <Terminal size={18} className="text-brand mr-2" />
          <h3 className="panel-title text-mono m-0">FACTORY ASSISTANT</h3>
        </div>
        <div className="status-indicator active"></div>
      </div>

      <div className="chat-window">
        {messages.map((msg) => (
          <div key={msg.id} className={`message-wrapper ${msg.sender}`}>
            {msg.sender === 'assistant' && (
              <div className="message-icon">
                <Bot size={16} />
              </div>
            )}
            <div className={`message-bubble ${msg.sender}`}>
              <div className="message-text text-mono">{msg.text}</div>
              
              {msg.structuredData && (
                <div className="structured-data mt-2">
                  {Object.entries(msg.structuredData).map(([key, value]) => (
                    <div className="data-row" key={key}>
                      <span className="data-key">{key.toUpperCase()}:</span>
                      <span className="data-value">{value}</span>
                    </div>
                  ))}
                </div>
              )}
              
              <div className="message-time">{msg.timestamp}</div>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="quick-actions mt-3">
        <button className="btn-quick text-mono" onClick={() => handleQuery("Explain defect")}>
          Explain defect
        </button>
        <button className="btn-quick text-mono" onClick={() => handleQuery("Suggest fix")}>
          Suggest fix
        </button>
        <button className="btn-quick text-mono" onClick={() => handleQuery("Is it critical?")}>
          Is it critical?
        </button>
      </div>

      <div className="input-area mt-3">
        <input 
          type="text" 
          className="chat-input text-mono"
          placeholder="ENTER QUERY..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button className="btn-send flex-center" onClick={() => handleQuery(inputValue)}>
          <Send size={16} />
        </button>
      </div>
    </div>
  );
};

export default React.memo(FactoryAssistant);
