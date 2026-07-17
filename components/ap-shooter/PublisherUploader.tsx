import React, { useState, useRef } from 'react';
import { UploadCloud, FileSpreadsheet, Plus, AlertCircle } from 'lucide-react';
import { parseFile } from '@/services/ap-shooter/csvParser';

interface PublisherUploaderProps {
  onImport: (publishers: string[]) => void;
}

export default function PublisherUploader({ onImport }: PublisherUploaderProps) {
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
  const [selectedCol, setSelectedCol] = useState('');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = async (selectedFile: File) => {
    const name = selectedFile.name.toLowerCase();
    if (!name.endsWith('.csv') && !name.endsWith('.xlsx') && !name.endsWith('.xls')) {
      setError('Only CSV and Excel (.xlsx, .xls) files are supported.');
      return;
    }
    setError('');
    setFile(selectedFile);

    try {
      const { headers: parsedHeaders, rows: parsedRows } = await parseFile(selectedFile);
      if (parsedHeaders.length === 0 || parsedRows.length === 0) {
        setError('The file appears to be empty.');
        return;
      }
      setHeaders(parsedHeaders);
      setRawRows(parsedRows);

      const pubIdCol = parsedHeaders.find(h =>
        /pub_?id/i.test(h) || /publisher_?id/i.test(h) || /publisher/i.test(h) || /^pub$/i.test(h)
      );
      setSelectedCol(pubIdCol || parsedHeaders[0] || '');
    } catch (err) {
      setError(`Failed to parse file: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = () => {
    setDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const handleImportClick = () => {
    if (!selectedCol) return;

    const extracted = [
      ...new Set(
        rawRows
          .map(row => row[selectedCol] !== undefined && row[selectedCol] !== null ? String(row[selectedCol]).trim() : '')
          .filter(Boolean)
      )
    ];

    if (extracted.length === 0) {
      setError('No valid publisher IDs found in the selected column.');
      return;
    }

    onImport(extracted as string[]);
    resetUploader();
  };

  const resetUploader = () => {
    setFile(null);
    setHeaders([]);
    setRawRows([]);
    setSelectedCol('');
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const previewList = selectedCol
    ? [
        ...new Set(
          rawRows
            .map(row => row[selectedCol] !== undefined && row[selectedCol] !== null ? String(row[selectedCol]).trim() : '')
            .filter(Boolean)
        )
      ].slice(0, 5)
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {!file ? (
        <div
          className={`uploader-area ${dragging ? 'dragging' : ''}`}
          style={{ padding: '2rem 1.5rem', fontSize: '0.9rem' }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={triggerFileInput}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept=".csv, .xlsx, .xls"
            style={{ display: 'none' }}
          />
          <UploadCloud size={32} className="uploader-icon" />
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontWeight: 600 }}>Bulk Import Publishers</p>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginTop: '0.15rem' }}>
              Drag & drop CSV/Excel here or browse
            </p>
          </div>
        </div>
      ) : (
        <div className="glass-card animated-fade-in" style={{ padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', overflow: 'hidden' }}>
              <FileSpreadsheet style={{ color: 'var(--primary)', flexShrink: 0 }} size={18} />
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{file.name}</span>
              </div>
            </div>
            <button
              className="btn btn-secondary btn-danger"
              onClick={resetUploader}
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
            >
              Cancel
            </button>
          </div>

          <div className="form-group" style={{ marginBottom: '1rem' }}>
            <label className="form-label" style={{ fontSize: '0.75rem' }}>Select Publisher ID Column</label>
            <select
              className="input-text"
              style={{ fontSize: '0.85rem', padding: '0.5rem 0.75rem' }}
              value={selectedCol}
              onChange={(e) => setSelectedCol(e.target.value)}
            >
              <option value="">-- Select Column --</option>
              {headers.map(h => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </div>

          {selectedCol && previewList.length > 0 && (
            <div style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: '0.4rem', padding: '0.75rem', marginBottom: '1rem' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', display: 'block', marginBottom: '0.4rem' }}>
                Preview Unique IDs:
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                {previewList.map((id, idx) => (
                  <code key={idx} style={{ fontSize: '0.75rem', padding: '0.1rem 0.35rem', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: '0.2rem' }}>
                    {id}
                  </code>
                ))}
                {rawRows.length > 5 && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>+ more</span>}
              </div>
            </div>
          )}

          <button
            className="btn btn-primary"
            style={{ width: '100%', padding: '0.5rem', fontSize: '0.85rem', gap: '0.35rem' }}
            onClick={handleImportClick}
            disabled={!selectedCol}
          >
            <Plus size={14} /> Import Publisher IDs
          </button>
        </div>
      )}

      {error && (
        <div style={{ background: 'var(--error-subtle)', border: '1px solid #fecaca', borderRadius: '0.4rem', padding: '0.75rem', color: 'var(--error)', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <AlertCircle size={14} style={{ flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
