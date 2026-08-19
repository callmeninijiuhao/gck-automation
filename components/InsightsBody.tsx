import React from 'react';

/** Strip Markdown decoration (#, **, *, _, `) from an AI narrative — the Insights
    box renders plain text, so raw Markdown symbols would show up literally. */
export function stripMarkdown(s: string): string {
  return s
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')       // ATX headings (# .. ######)
    .replace(/\*\*([^*]+)\*\*/g, '$1')        // **bold**
    .replace(/__([^_]+)__/g, '$1')            // __bold__
    .replace(/\*([^*]+)\*/g, '$1')            // *italic*
    .replace(/`([^`]+)`/g, '$1')              // `code`
    .replace(/^\s{0,3}[-*]\s+/gm, '• ')       // list bullets -> •
    .trim();
}

/** Colour signed deltas (e.g. "+12%" green, "-8%" red, bold) inside plain text. */
const DELTA_RE = /([+\-]\d+(?:\.\d+)?%)/g;
const colorizeDeltas = (text: string): React.ReactNode[] => {
  const out: React.ReactNode[] = [];
  let last = 0; let key = 0; let m: RegExpExecArray | null;
  DELTA_RE.lastIndex = 0;
  while ((m = DELTA_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const up = m[0].startsWith('+');
    out.push(<strong key={key++} style={{ color: up ? 'var(--success)' : 'var(--error)' }}>{m[0]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

// The AI briefing labels its sections in Title Case ("Executive Summary"), the
// deterministic summary has none, and some models shout in ALL CAPS — treat all
// three as section headings. Includes the Discrepancy review's section names.
const SECTION_TITLES = /^(executive summary|key points?|key findings?|key takeaways?|key changes?|game changers?|change contributors?|recommendations?|summary|findings?|overview|next steps|data health|anomalies to check|suggested follow-ups?)\s*:?$/i;
const isInsightHeading = (l: string) =>
  SECTION_TITLES.test(l) || (/^[A-Z0-9][A-Z0-9 ,&/()\-]{2,39}:?$/.test(l) && !/[a-z]/.test(l));
const insightBullet = (l: string) => l.match(/^(?:[•\-*]|\d+\.)\s+(.*)$/);
// A short standalone Title-Case label (no digits/punctuation) is a topic category.
const isInsightCategory = (l: string) => l.length <= 40 && /^[A-Za-z][A-Za-z &/()'-]*$/.test(l);

/** Colour signed deltas in a line (no label auto-bolding). */
const emphasizeLabel = (s: string): React.ReactNode => <>{colorizeDeltas(s)}</>;

/** Render an Insights / AI-review narrative professionally: ALL-CAPS (or known
    section) lines become subheadings, "• / - / 1." lines become hanging bullets,
    and signed deltas are coloured. Shared by the Bundle and Discrepancy tools so
    their AI output reads identically. */
export const InsightsBody: React.FC<{ text: string }> = ({ text }) => {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <div style={{ fontSize: 'var(--text-body)', color: 'var(--text-primary)' }}>
      {lines.map((line, i) => {
        const b = insightBullet(line);
        const core = b ? b[1] : line;   // a heading may arrive wrapped as a bullet ("• Executive Summary")
        if (isInsightHeading(core)) {
          return (
            <p key={i} style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--primary)', margin: i === 0 ? '0 0 0.4rem' : '1rem 0 0.4rem' }}>
              {core.replace(/:$/, '')}
            </p>
          );
        }
        if (b) {
          return (
            <div key={i} style={{ display: 'flex', gap: '0.5rem', margin: '0.3rem 0', lineHeight: 1.6, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--primary)', flexShrink: 0 }}>•</span>
              <span>{emphasizeLabel(b[1])}</span>
            </div>
          );
        }
        if (!b && isInsightCategory(core)) {
          return (
            <p key={i} style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)', margin: '0.7rem 0 0.2rem' }}>
              {core.replace(/:$/, '')}
            </p>
          );
        }
        return <p key={i} style={{ margin: '0.4rem 0', lineHeight: 1.65 }}>{emphasizeLabel(line)}</p>;
      })}
    </div>
  );
};
