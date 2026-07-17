import React, { useState, useRef } from 'react';
import { UploadCloud, CheckCircle2, FileSpreadsheet, Trash2, ArrowRight } from 'lucide-react';
import { parseFile, autoDetectMappings, mapParsedData, type ColumnMappings, type MappedDeal } from '@/services/ap-shooter/csvParser';

interface UploaderSavedState {
  file: File | null;
  headers: string[];
  rawRows: Record<string, unknown>[];
  mappings: ColumnMappings;
}

interface WantedListUploaderProps {
  onUploadComplete: (payload: {
    wantedDeals: MappedDeal[];
    detectedPublishers: string[];
    rawState: UploaderSavedState;
  }) => void;
  savedState?: UploaderSavedState | null;
}

export default function WantedListUploader({ onUploadComplete, savedState }: WantedListUploaderProps) {
  const [file, setFile] = useState<File | null>(savedState?.file || null);
  const [headers, setHeaders] = useState<string[]>(savedState?.headers || []);
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>(savedState?.rawRows || []);
  const [mappings, setMappings] = useState<ColumnMappings>(() => {
    const base: ColumnMappings = savedState?.mappings || {
      dealIdCol: '', dealNameCol: '', ownerCol: '', ownerMetaCol: '', pubIdCol: '', revenueCol: ''
    };
    if (savedState?.headers?.length > 0) {
      const fresh = autoDetectMappings(savedState.headers);
      return {
        dealIdCol: base.dealIdCol || fresh.dealIdCol || '',
        dealNameCol: base.dealNameCol || fresh.dealNameCol || '',
        ownerCol: base.ownerCol || fresh.ownerCol || '',
        ownerMetaCol: base.ownerMetaCol || fresh.ownerMetaCol || '',
        pubIdCol: base.pubIdCol || fresh.pubIdCol || '',
        revenueCol: base.revenueCol || fresh.revenueCol || ''
      };
    }
    return base;
  });
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
        setError('The uploaded file appears to be empty.');
        return;
      }
      setHeaders(parsedHeaders);
      setRawRows(parsedRows);

      const autoMappings = autoDetectMappings(parsedHeaders);
      setMappings(autoMappings);
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

  const resetUploader = () => {
    setFile(null);
    setHeaders([]);
    setRawRows([]);
    setError('');
    setMappings({
      dealIdCol: '',
      dealNameCol: '',
      ownerCol: '',
      pubIdCol: '',
      revenueCol: ''
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const mappedData = mapParsedData(rawRows, mappings);
  const previewRows = mappedData;

  const handleConfirm = () => {
    if (!mappings.dealIdCol) {
      setError('Deal ID mapping is required.');
      return;
    }

    if (mappedData.length === 0) {
      setError('No valid deal rows could be parsed with the selected mappings.');
      return;
    }



    let detectedPublishers: string[] = [];
    if (mappings.pubIdCol) {
      detectedPublishers = [...new Set(mappedData
        .map(d => d.pubId)
        .filter(Boolean)
      )];
    }

    onUploadComplete({
      wantedDeals: mappedData,
      detectedPublishers,
      rawState: {
        file,
        headers,
        rawRows,
        mappings
      }
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {!file ? (
        <div
          className={`uploader-area ${dragging ? 'dragging' : ''}`}
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
          <UploadCloud size={48} className="uploader-icon" />
          <div>
            <p style={{ fontWeight: 600, fontSize: '1.1rem' }}>
              Drag and drop your Wanted List (CSV/Excel) here
            </p>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.25rem' }}>
              Or click to browse files
            </p>
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            File columns should ideally contain: deal ID, deal name, owner, and optionally publisher IDs.
          </span>
        </div>
      ) : (
        <div className="glass-card animated-fade-in">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <FileSpreadsheet style={{ color: 'var(--primary)' }} />
              <div>
                <h3 style={{ fontWeight: 600, fontSize: '1.05rem' }}>{file.name}</h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {(file.size / 1024).toFixed(1)} KB · {rawRows.length} rows loaded
                </span>
              </div>
            </div>
            <button className="btn btn-secondary btn-danger" onClick={resetUploader} style={{ padding: '0.5rem 0.75rem' }}>
              <Trash2 size={16} />
            </button>
          </div>

          {mappings.dealIdCol && mappedData.length > 0 && (
            <div style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: '0.625rem', padding: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                  Preview
                </span>
                <span style={{ fontSize: '0.8rem', color: 'var(--success)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <CheckCircle2 size={14} /> Mapped {mappedData.length} deals successfully
                </span>
              </div>

              {!mappings.ownerCol && (
                <div style={{ background: 'var(--warning-subtle)', border: '1px solid #fde68a', borderRadius: '0.5rem', padding: '0.625rem 0.875rem', marginBottom: '0.75rem', fontSize: '0.8rem', color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span style={{ fontWeight: 600 }}>⚠ No Deal Owner column detected.</span>
                  <span>Without deal owners, outreach messages cannot be personalized and will show &quot;Unknown Owner&quot;.</span>
                </div>
              )}

              <div className="table-container" style={{ maxHeight: '55vh', minHeight: '320px', overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Deal ID</th>
                      <th>Deal Name</th>
                      <th>Deal Owner</th>
                      <th>Metadata Owner</th>
                      <th>Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, idx) => (
                      <tr key={idx}>
                        <td><code>{row.id}</code></td>
                        <td>{row.name}</td>
                        <td style={{ color: row.owner ? 'inherit' : 'var(--text-muted)', fontStyle: row.owner ? 'inherit' : 'italic' }}>
                          {row.owner || '—'}
                        </td>
                        <td style={{ color: row.ownerMeta ? 'inherit' : 'var(--text-muted)' }}>
                          {row.ownerMeta || '—'}
                        </td>
                        <td>
                          {row.revenue > 0 ? `$${row.revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div style={{ background: 'var(--error-subtle)', border: '1px solid #fecaca', borderRadius: '0.625rem', padding: '1rem', color: 'var(--error)', fontSize: '0.875rem' }}>
          {error}
        </div>
      )}

      {file && (
        <button
          className="btn btn-primary"
          style={{ alignSelf: 'flex-end' }}
          onClick={handleConfirm}
          disabled={!mappings.dealIdCol || mappedData.length === 0}
        >
          Confirm Wanted List <ArrowRight size={16} />
        </button>
      )}
    </div>
  );
}
