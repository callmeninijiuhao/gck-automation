import React, { useState, useMemo } from 'react';
import { Download, ArrowRight, CheckCircle2, XCircle, Search } from 'lucide-react';
import { exportGapsToCsv, exportGapsToExcel, type GapDataItem } from '@/services/ap-shooter/exportCsv';

interface GapAnalysisProps {
  stats: {
    totalPublishers: number;
    publishersWithGaps: number;
    totalGaps: number;
    totalMissingRevenue: number;
  };
  gapData: GapDataItem[];
  onProceed: () => void;
  onPrev: () => void;
}

interface ExpandedRow {
  type: 'failed' | 'complete' | 'gap';
  pubId: string;
  owner: string | null;
  deals: Array<{ id: string; name: string; owner: string; revenue?: number }>;
  revenue: number;
  errorMsg?: string;
  isFirstOwner?: boolean;
  isMetadataFallback?: boolean;
  isMissing?: boolean;
}

export default function GapAnalysis({
  stats,
  gapData,
  onProceed,
  onPrev
}: GapAnalysisProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterGapsOnly, setFilterGapsOnly] = useState(false);

  const expandedRows = useMemo(() => {
    const rows: ExpandedRow[] = [];
    gapData.forEach(record => {
      if (record.failed) {
        rows.push({
          type: 'failed',
          pubId: record.pubId,
          owner: null,
          deals: [],
          revenue: 0,
          errorMsg: record.errorMsg
        });
        return;
      }
      if (record.missingDeals.length === 0) {
        rows.push({
          type: 'complete',
          pubId: record.pubId,
          owner: null,
          deals: [],
          revenue: 0
        });
        return;
      }
      const byOwner: Record<string, { deals: Array<{ id: string; name: string; owner: string; revenue?: number }>; revenue: number; isMetadataFallback: boolean; isMissing: boolean }> = {};
      record.missingDeals.forEach(deal => {
        const rawOwners = deal.owner
          ? String(deal.owner).split(',').map(o => o.trim()).filter(Boolean)
          : [''];
        rawOwners.forEach(owner => {
          if (!byOwner[owner]) {
            byOwner[owner] = { deals: [], revenue: 0, isMetadataFallback: false, isMissing: owner === '' };
          }
          byOwner[owner].deals.push({ id: deal.id, name: deal.name, owner: deal.owner, revenue: deal.revenue });
          byOwner[owner].revenue += deal.revenue || 0;
        });
      });
      Object.entries(byOwner).forEach(([owner, data], idx) => {
        rows.push({
          type: 'gap',
          pubId: record.pubId,
          isFirstOwner: idx === 0,
          owner,
          isMetadataFallback: data.isMetadataFallback,
          isMissing: data.isMissing,
          deals: data.deals,
          revenue: data.revenue
        });
      });
    });
    return rows;
  }, [gapData]);

  const filteredRows = useMemo(() => {
    return expandedRows.filter(row => {
      const matchesSearch =
        row.pubId.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (row.owner && row.owner.toLowerCase().includes(searchTerm.toLowerCase())) ||
        row.deals.some(d => d.id.toLowerCase().includes(searchTerm.toLowerCase()) || d.name.toLowerCase().includes(searchTerm.toLowerCase()));

      const matchesGapsFilter = !filterGapsOnly || row.type !== 'complete';
      return matchesSearch && matchesGapsFilter;
    });
  }, [expandedRows, searchTerm, filterGapsOnly]);

  const handleExport = () => {
    exportGapsToCsv(gapData);
  };

  return (
    <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Gap Analysis Report</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            Missing deal mappings per publisher, broken down by deal owner.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={handleExport} style={{ display: 'inline-flex', gap: '0.5rem' }}>
            <Download size={16} /> Export CSV
          </button>
          <button className="btn btn-secondary" onClick={() => exportGapsToExcel(gapData)} style={{ display: 'inline-flex', gap: '0.5rem' }}>
            <Download size={16} /> Export Excel
          </button>
        </div>
      </div>

      <div className="metrics-grid">
        <div className="metric-card">
          <span className="metric-title">Publishers Checked</span>
          <span className="metric-value">{stats.totalPublishers}</span>
        </div>

        <div className="metric-card" style={{ borderLeft: '3px solid var(--warning)' }}>
          <span className="metric-title">Publishers with Gaps</span>
          <span className="metric-value" style={{ color: stats.publishersWithGaps > 0 ? 'var(--warning)' : 'var(--text-primary)' }}>
            {stats.publishersWithGaps}
          </span>
        </div>

        <div className="metric-card" style={{ borderLeft: stats.totalGaps > 0 ? '3px solid var(--error)' : '3px solid var(--success)' }}>
          <span className="metric-title">Total Missing Mappings</span>
          <span className="metric-value" style={{ color: stats.totalGaps > 0 ? 'var(--error)' : 'var(--success)' }}>
            {stats.totalGaps}
          </span>
        </div>

        <div className="metric-card" style={{ borderLeft: stats.totalMissingRevenue > 0 ? '3px solid var(--secondary)' : '3px solid var(--success)' }}>
          <span className="metric-title">Missed Revenue Opportunity</span>
          <span className="metric-value" style={{ color: stats.totalMissingRevenue > 0 ? 'var(--secondary)' : 'var(--success)' }}>
            {stats.totalMissingRevenue > 0
              ? `$${stats.totalMissingRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : '$0.00'}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: '0.625rem', padding: '0.75rem 1rem' }}>
        <div style={{ position: 'relative', flex: '1', minWidth: '250px', maxWidth: '400px' }}>
          <input
            type="text"
            className="input-text"
            placeholder="Search publisher ID, deal, or owner..."
            style={{ paddingLeft: '2.5rem' }}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <Search size={16} style={{ position: 'absolute', left: '0.85rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={filterGapsOnly}
            onChange={(e) => setFilterGapsOnly(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          Show only publishers with gaps or errors
        </label>
      </div>

      <div className="table-container">
        {filteredRows.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            No publisher records match your search filters.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '12%' }}>Publisher ID</th>
                <th style={{ width: '15%' }}>Deal Owner</th>
                <th style={{ width: '43%' }}>Missing AP Deals</th>
                <th style={{ width: '15%', textAlign: 'right' }}>Revenue Potential</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row, index) => {
                if (row.type === 'failed') {
                  return (
                    <tr key={`${row.pubId}-failed`}>
                      <td><code>{row.pubId}</code></td>
                      <td style={{ color: 'var(--text-muted)' }}>—</td>
                      <td colSpan={2}>
                        <span className="badge badge-error" style={{ display: 'inline-flex', gap: '0.25rem' }}>
                          <XCircle size={12} /> Fetch Failed
                        </span>
                        <span style={{ color: 'var(--error)', fontStyle: 'italic', fontSize: '0.85rem', marginLeft: '0.5rem' }}>
                          {row.errorMsg ? String(row.errorMsg).replace(/^✗ Failed:\s*/, '') : 'API failed to respond for this publisher.'}
                        </span>
                      </td>
                    </tr>
                  );
                }

                if (row.type === 'complete') {
                  return (
                    <tr key={`${row.pubId}-ok`}>
                      <td><code>{row.pubId}</code></td>
                      <td style={{ color: 'var(--text-muted)' }}>—</td>
                      <td colSpan={2}>
                        <span style={{ color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.875rem', fontWeight: 500 }}>
                          <CheckCircle2 size={15} /> All deals mapped
                        </span>
                      </td>
                    </tr>
                  );
                }

                const showPubId = row.isFirstOwner;

                return (
                  <tr key={`${row.pubId}-${row.owner}`}>
                    <td style={{ borderBottom: showPubId ? undefined : 'none', verticalAlign: 'top' }}>
                      {showPubId && <code>{row.pubId}</code>}
                    </td>
                    <td style={{ verticalAlign: 'top', wordBreak: 'break-all', fontSize: '0.9rem' }}>
                      {row.isMissing ? (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      ) : (
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {row.owner}
                          {row.isMetadataFallback && (
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginLeft: '0.4rem' }}>(metadata)</span>
                          )}
                        </span>
                      )}
                    </td>
                    <td style={{ verticalAlign: 'top', fontSize: '0.9rem' }}>
                      {row.deals.map((d, i) => (
                        <div
                          key={i}
                          title={d.name || d.id}
                          style={{
                            padding: '0.35rem 0',
                            borderBottom: i < row.deals.length - 1 ? '1px dashed var(--border)' : 'none',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}
                        >
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginRight: '0.4rem' }}>{i + 1}.</span>
                          {d.name || d.id}
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>
                            {d.owner ? `(${d.owner})` : '(no owner)'}
                          </span>
                        </div>
                      ))}
                    </td>
                    <td style={{ verticalAlign: 'top', textAlign: 'right', fontSize: '0.9rem' }}>
                      {row.deals.map((d, i) => (
                        <div
                          key={i}
                          style={{
                            padding: '0.35rem 0',
                            fontWeight: 600,
                            color: (d.revenue || 0) > 0 ? 'var(--secondary)' : 'var(--text-primary)',
                            borderBottom: i < row.deals.length - 1 ? '1px dashed var(--border)' : 'none'
                          }}
                        >
                          {(d.revenue || 0) > 0
                            ? `$${d.revenue!.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                            : '$0.00'}
                        </div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {stats.totalGaps === 0 && (
        <div style={{ background: 'var(--success-subtle)', border: '1px solid #bbf7d0', borderRadius: '0.625rem', padding: '1.25rem', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '0.25rem', alignItems: 'center' }}>
          <CheckCircle2 size={32} style={{ color: 'var(--success)' }} />
          <h4 style={{ fontWeight: 600, color: 'var(--success)', marginTop: '0.25rem' }}>No Gaps Found</h4>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            All publishers are 100% mapped to the wanted Auction Packages. No outreach is required.
          </p>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: '1.5rem', marginTop: '0.5rem' }}>
        <button className="btn btn-secondary" onClick={onPrev}>
          Back to API Config
        </button>

        {stats.totalGaps > 0 && (
          <button className="btn btn-primary" onClick={onProceed}>
            Generate Outreach <ArrowRight size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
