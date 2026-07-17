import React, { useEffect, useRef } from 'react';
import { Play, Square, Check, RefreshCcw } from 'lucide-react';

interface LogEntry {
  timestamp: string;
  type: 'info' | 'success' | 'error';
  text: string;
}

interface FetchProgressProps {
  isFetching: boolean;
  logs: LogEntry[];
  completedCount: number;
  totalCount: number;
  onCancel: () => void;
  onProceed: () => void;
  onReset: () => void;
  onBackToConfig: () => void;
}

export default function FetchProgress({
  isFetching,
  logs,
  completedCount,
  totalCount,
  onCancel,
  onProceed,
  onReset,
  onBackToConfig
}: FetchProgressProps) {
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [logs]);

  const percentage = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const isFinished = completedCount === totalCount && totalCount > 0;
  const hasErrors = logs.some(l => l.type === 'error');

  return (
    <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>
          {isFetching ? 'Fetching Live Deals...' : isFinished ? 'Fetch Complete!' : 'Fetch Interrupted'}
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
          Retrieving monetizing package lists sequentially to respect API rate limits.
        </p>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.9rem', fontWeight: 600 }}>
        <span>Progress: {completedCount} / {totalCount} publishers</span>
        <span>{percentage}%</span>
      </div>

      <div className="progress-bar-container">
        <div className="progress-bar-fill" style={{ width: `${percentage}%` }} />
      </div>

      <div className="log-console" ref={consoleRef}>
        <div className="log-line info">[SYSTEM] Sequential API fetch pipeline initialized.</div>
        {logs.map((log, index) => (
          <div key={index} className={`log-line ${log.type}`}>
            <span style={{ color: 'var(--text-muted)', marginRight: '0.5rem' }}>{log.timestamp}</span>
            {log.text}
          </div>
        ))}
        {isFetching && (
          <div className="log-line info" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span className="spinner" style={{
              display: 'inline-block',
              width: '10px',
              height: '10px',
              border: '2px solid var(--border-strong)',
              borderRadius: '50%',
              borderTopColor: 'var(--primary)',
              animation: 'ap-spin 0.8s linear infinite'
            }} />
            Polling next publisher...
          </div>
        )}
      </div>

      <style>{`
        @keyframes ap-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: '1.5rem', marginTop: '0.5rem' }}>
        <div>
          {!isFetching && !isFinished && (
            <button className="btn btn-secondary" onClick={onReset} style={{ display: 'inline-flex', gap: '0.5rem' }}>
              <RefreshCcw size={16} /> Reset
            </button>
          )}
          {!isFetching && (
            <button className="btn btn-secondary" onClick={onBackToConfig} style={{ display: 'inline-flex', gap: '0.5rem', marginLeft: '0.5rem' }}>
              Back to Config
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: '1rem' }}>
          {isFetching ? (
            <button className="btn btn-secondary btn-danger" onClick={onCancel} style={{ display: 'inline-flex', gap: '0.5rem' }}>
              <Square size={14} fill="currentColor" /> Cancel/Stop
            </button>
          ) : isFinished ? (
            <button className="btn btn-primary" onClick={onProceed} style={{ display: 'inline-flex', gap: '0.5rem' }}>
              View Gap Report <Check size={16} />
            </button>
          ) : (
            <button className="btn btn-primary" onClick={onProceed}>
              View Partial Report
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
