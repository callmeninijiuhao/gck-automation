import React, { useState, useMemo, useRef } from 'react';
import { Copy, Check, CheckCircle2, HelpCircle, Plus, User, List, Hash, BarChart3 } from 'lucide-react';
import { groupGapsByOwner, renderMessage, type GroupedGap } from '@/services/ap-shooter/messageRenderer';
import type { GapDataItem } from '@/services/ap-shooter/exportCsv';

export const DEFAULT_TEMPLATE = `Hi {owner_name},

I'm reaching out regarding Auction Package deal mapping for some of our publishers.

The following deals require mapping updates for eligible publishers:

{deal_list}

Could you please arrange to map these publishers to the respective deals? Let me know if you need any additional information.

Thanks,
[Your Name]`;

const VARIABLES = [
  { key: '{owner_name}', label: 'Owner Name', icon: User, desc: 'Capitalized owner name' },
  { key: '{deal_list}', label: 'Deal List', icon: List, desc: 'Deals + missing publishers' },
  { key: '{deal_count}', label: 'Deal Count', icon: Hash, desc: 'Number of deals' },
  { key: '{publisher_count}', label: 'Pub Count', icon: BarChart3, desc: 'Number of publishers' },
];

interface OutreachMessagesProps {
  gapData: GapDataItem[];
  onPrev: () => void;
  template?: string;
  onTemplateChange?: (template: string) => void;
}

export default function OutreachMessages({ gapData, onPrev, template: controlledTemplate, onTemplateChange }: OutreachMessagesProps) {
  const [internalTemplate, setInternalTemplate] = useState(DEFAULT_TEMPLATE);
  const template = controlledTemplate !== undefined ? controlledTemplate : internalTemplate;
  const setTemplate = onTemplateChange || setInternalTemplate;

  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedOwner, setSelectedOwner] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const groupedGaps = useMemo(() => {
    return groupGapsByOwner(gapData);
  }, [gapData]);

  const ownerOptions = useMemo(() => {
    return groupedGaps.map(g => ({ value: g.owner, label: `${g.owner} (${g.deals.length} deals)` }));
  }, [groupedGaps]);

  const selectedOwnerData = useMemo(() => {
    if (!selectedOwner) return null;
    return groupedGaps.find(g => g.owner === selectedOwner) || null;
  }, [selectedOwner, groupedGaps]);

  const renderedMessages = useMemo(() => {
    const source = selectedOwner
      ? groupedGaps.filter(g => g.owner === selectedOwner)
      : groupedGaps;

    return source.map((group, index) => {
      const messageText = renderMessage(template, group);
      const totalPubCount = group.deals.reduce((acc, d) => acc + d.publishers.length, 0);

      return {
        id: `${group.owner}-${index}`,
        recipient: group.owner,
        dealCount: group.deals.length,
        publisherCount: totalPubCount,
        text: messageText,
        deals: group.deals
      };
    });
  }, [groupedGaps, template, selectedOwner]);

  const insertVariable = (variable: string) => {
    const ta = textareaRef.current;
    if (!ta) return;

    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = template.slice(0, start);
    const after = template.slice(end);
    const newTemplate = before + variable + after;

    setTemplate(newTemplate);

    setTimeout(() => {
      ta.focus();
      const newCursor = start + variable.length;
      ta.setSelectionRange(newCursor, newCursor);
    }, 0);
  };

  const handleCopySingle = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleCopyAll = () => {
    const separator = '\n\n---\n\n';
    const allText = renderedMessages
      .map(m => `To: ${m.recipient}\nSubject: Consolidated AP Deal Mapping Update Required\n\n${m.text}`)
      .join(separator);

    navigator.clipboard.writeText(allText);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  return (
    <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Generate Outreach Messages</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            Consolidated outreach messages grouped by Deal Owner. Use the variable buttons to insert placeholders, and select an owner to preview their specific deals.
          </p>
        </div>
        {renderedMessages.length > 0 && (
          <button
            className="btn btn-primary"
            onClick={handleCopyAll}
            style={{ display: 'inline-flex', gap: '0.5rem', background: 'var(--secondary)' }}
          >
            {copiedAll ? <CheckCircle2 size={16} /> : <Copy size={16} />}
            {copiedAll ? 'All Copied!' : 'Copy All Messages'}
          </button>
        )}
      </div>

      <div className="grid-2" style={{ alignItems: 'start', gap: '2rem' }}>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="form-label">Outreach Template</label>
              <button
                className="btn btn-secondary"
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', borderRadius: '0.3rem' }}
                onClick={() => setTemplate(DEFAULT_TEMPLATE)}
              >
                Reset to Default
              </button>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
              {VARIABLES.map(v => {
                const Icon = v.icon;
                return (
                  <button
                    key={v.key}
                    className="btn btn-secondary"
                    style={{ padding: '0.35rem 0.6rem', fontSize: '0.75rem', gap: '0.3rem' }}
                    onClick={() => insertVariable(v.key)}
                    title={`Insert ${v.label} — ${v.desc}`}
                  >
                    <Plus size={12} /> <Icon size={12} /> {v.label}
                  </button>
                );
              })}
            </div>

            <textarea
              ref={textareaRef}
              className="textarea"
              style={{ minHeight: '240px', fontSize: '0.9rem', lineHeight: '1.5' }}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            />
          </div>

          <div style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: '0.625rem', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
              <User size={14} /> Preview by Deal Owner
            </div>
            <select
              className="input-text"
              value={selectedOwner}
              onChange={(e) => setSelectedOwner(e.target.value)}
            >
              <option value="">All Owners ({groupedGaps.length})</option>
              {ownerOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>

            {selectedOwnerData && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                  Deals for {selectedOwnerData.ownerName}:
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: '160px', overflowY: 'auto' }}>
                  {selectedOwnerData.deals.map(deal => (
                    <div key={deal.dealId} style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '0.35rem 0.5rem', background: 'var(--bg-surface)', borderRadius: '0.3rem', border: '1px solid var(--border)' }}>
                      <strong style={{ color: 'var(--primary)' }}>{deal.dealId}</strong> — {deal.dealName}
                      <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>
                        ({deal.publishers.length} pub{deal.publishers.length !== 1 ? 's' : ''})
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: '0.625rem', padding: '1rem' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
              <HelpCircle size={14} /> Available Template Variables
            </span>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              <tbody>
                {VARIABLES.map((v, i) => (
                  <tr key={v.key} style={{ borderBottom: i < VARIABLES.length - 1 ? '1px solid var(--border)' : undefined }}>
                    <td style={{ padding: '0.4rem 0', fontWeight: 'bold', color: 'var(--primary)', width: '35%' }}><code>{v.key}</code></td>
                    <td style={{ padding: '0.4rem 0' }}>{v.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: '720px', overflowY: 'auto', paddingRight: '0.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
              Rendered Emails ({renderedMessages.length})
            </span>
            {selectedOwner && (
              <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => setSelectedOwner('')}>
                Show All
              </button>
            )}
          </div>

          {renderedMessages.length === 0 ? (
            <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)', border: '1px dashed var(--border-strong)', borderRadius: '0.75rem', background: 'var(--bg-subtle)' }}>
              No messages generated. Is the gap list empty?
            </div>
          ) : (
            renderedMessages.map((msg) => {
              const isCopied = copiedId === msg.id;
              return (
                <div key={msg.id} className="email-card animated-fade-in">
                  <div className="email-header">
                    <div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>RECIPIENT</div>
                      <div className="email-recipient">{msg.recipient}</div>
                    </div>

                    <div className="email-badges">
                      <span className="badge badge-info">
                        {msg.dealCount} Deal{msg.dealCount !== 1 ? 's' : ''}
                      </span>
                      <span className="badge badge-warning">
                        {msg.publisherCount} Pub{msg.publisherCount !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>

                  <div className="email-body" style={{ fontSize: '0.9rem' }}>
                    {msg.text}
                  </div>

                  <button
                    className={`btn ${isCopied ? 'btn-secondary' : 'btn-primary'}`}
                    style={{ alignSelf: 'flex-end', padding: '0.4rem 0.8rem', fontSize: '0.8rem', gap: '0.35rem', minWidth: '100px' }}
                    onClick={() => handleCopySingle(msg.id, msg.text)}
                  >
                    {isCopied ? <Check size={14} /> : <Copy size={14} />}
                    {isCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              );
            })
          )}
        </div>

      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: '1.5rem', marginTop: '0.5rem' }}>
        <button className="btn btn-secondary" onClick={onPrev}>
          Back to Gap Report
        </button>
      </div>
    </div>
  );
}
