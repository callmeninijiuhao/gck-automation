// ─────────────────────────────────────────────
// 数据清洗 / 聚合 / 排序 / 高亮 / 兜底摘要
// Ported from daily_report.py (pandas → TS)
// ─────────────────────────────────────────────
import {
  DiscrepancyRow, DspSummaryRow, DISCREPANCY_CONFIG,
  RENAME_MAP, NUMERIC_FIELDS, PERCENTAGE_FIELDS,
} from './types';

/** 带千分位逗号的字符串 → number（失败返回 null） */
const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

export const fmtPct = (x: number | null | undefined): string =>
  x === null || x === undefined || !Number.isFinite(x) ? 'N/A' : `${(x * 100).toFixed(2)}%`;

export const fmtNum = (x: number | null | undefined): string => {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'N/A';
  return Number.isInteger(x)
    ? x.toLocaleString('en-US')
    : x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** 原始行（列名为 PubMatic CSV 列名）→ 统一 DiscrepancyRow */
export function standardizeRows(rawRows: Record<string, unknown>[], publisherId: string): DiscrepancyRow[] {
  const rows: DiscrepancyRow[] = rawRows.map((raw) => {
    const r: Partial<DiscrepancyRow> = {};
    for (const [csvCol, field] of Object.entries(RENAME_MAP)) {
      if (csvCol in raw) {
        let v = raw[csvCol];
        // 清洗字段值里的换行符（上游偶发的脏数据），避免污染展示和导出
        if (typeof v === 'string') v = v.replace(/[\r\n]+/g, ' ').trim();
        (r as Record<string, unknown>)[field] = v;
      }
    }
    for (const f of NUMERIC_FIELDS) {
      if (f in r) (r as Record<string, unknown>)[f] = toNum((r as Record<string, unknown>)[f]);
    }
    if (!r.publisherId) r.publisherId = publisherId;
    r.publisherId = String(r.publisherId).replace(/\.0$/, '');
    r.dsp = String(r.dsp ?? 'Unknown');
    return r as DiscrepancyRow;
  });

  // 百分比字段：若最大绝对值 > 1，说明是"百分点数字"，统一除以 100
  for (const f of PERCENTAGE_FIELDS) {
    const maxAbs = Math.max(...rows.map((r) => Math.abs((r[f] as number) ?? 0)));
    if (maxAbs > 1) {
      for (const r of rows) {
        const v = r[f] as number | null;
        if (v !== null && v !== undefined) (r as unknown as Record<string, unknown>)[f] = v / 100;
      }
    }
  }

  // 计算 impression discrepancy（如果 API 没直接给）
  for (const r of rows) {
    if ((r.discrepancyRate === null || r.discrepancyRate === undefined) &&
        r.pubmaticImps !== null && r.dspImps !== null && r.pubmaticImps !== 0) {
      r.discrepancyRate = Math.abs((r.pubmaticImps - r.dspImps) / r.pubmaticImps);
    }
    const spendAlert = r.spendDiscrepancyPct !== null && Math.abs(r.spendDiscrepancyPct) > DISCREPANCY_CONFIG.alertThreshold;
    const impsAlert = r.discrepancyRate !== null && Math.abs(r.discrepancyRate) > DISCREPANCY_CONFIG.alertThreshold;
    r.needsAttention = spendAlert || impsAlert;
  }

  return rows;
}

/** 去重：保留每个 Publisher-DSP 组合的第一条，丢弃后续重复。返回 { unique, duplicates } */
export function deduplicateRows(rows: DiscrepancyRow[]): { unique: DiscrepancyRow[]; duplicates: DiscrepancyRow[] } {
  const seen = new Map<string, DiscrepancyRow>();
  const unique: DiscrepancyRow[] = [];
  const duplicates: DiscrepancyRow[] = [];

  for (const r of rows) {
    const key = `${r.publisherId}|${r.dsp}`;
    if (seen.has(key)) {
      duplicates.push(r);
    } else {
      seen.set(key, r);
      unique.push(r);
    }
  }

  return { unique, duplicates };
}

/** 过滤掉 DSP / PubMatic 两边 spend 都 < 1 的无意义行 */
export const filterLowSpendRows = (rows: DiscrepancyRow[]): DiscrepancyRow[] =>
  rows.filter((r) => (r.dspSpend ?? 0) >= 1 || (r.pubmaticSpend ?? 0) >= 1);

/**
 * 剔除明显错位的脏行（CSV 未加引号的逗号会让整行字段串位）。
 * 第一道防线在 apiService（PapaParse 的 __parsed_extra 信号）；这里是兜底启发式：
 * - DSP 名是纯数字（数字窜进了文本列）
 * - publisher ID 不是纯数字
 * - 曝光数出现小数（impressions 必须是整数，小数说明 spend 窜了位）
 * 丢弃的行会由调用方写入 Run Log，绝不静默吞掉。
 */
export function validateRows(rows: DiscrepancyRow[]): { valid: DiscrepancyRow[]; dropped: DiscrepancyRow[] } {
  const valid: DiscrepancyRow[] = [];
  const dropped: DiscrepancyRow[] = [];
  const fractional = (v: number | null | undefined) =>
    v !== null && v !== undefined && Number.isFinite(v) && !Number.isInteger(v);
  for (const r of rows) {
    const dsp = (r.dsp ?? '').trim();
    const dspLooksNumeric = /^-?[\d,]+(\.\d+)?$/.test(dsp);
    const pidOk = /^\d+$/.test(r.publisherId);
    const impsCorrupted = fractional(r.pubmaticImps) || fractional(r.dspImps);
    if (!dsp || dspLooksNumeric || !pidOk || impsCorrupted) {
      dropped.push(r);
    } else {
      valid.push(r);
    }
  }
  return { valid, dropped };
}

/** 按 DSP 聚合（团队整体视角），按 |Spend Discrepancy| 降序 */
export function aggregateByDsp(rows: DiscrepancyRow[]): DspSummaryRow[] {
  const groups = new Map<string, DiscrepancyRow[]>();
  for (const r of rows) {
    const list = groups.get(r.dsp) ?? [];
    list.push(r);
    groups.set(r.dsp, list);
  }
  const sum = (list: DiscrepancyRow[], f: keyof DiscrepancyRow) =>
    list.reduce((acc, r) => acc + ((r[f] as number) ?? 0), 0);

  const result: DspSummaryRow[] = [...groups.entries()].map(([dsp, list]) => {
    const pubmaticSpend = sum(list, 'pubmaticSpend');
    const dspSpend = sum(list, 'dspSpend');
    const pubmaticImps = sum(list, 'pubmaticImps');
    const dspImps = sum(list, 'dspImps');

    // 验证：聚合后的绝对差值应该等于原始行的绝对差值之和（舍入误差除外）
    const expectedSpendAbs = sum(list, 'spendDiscrepancyAbs');
    const actualSpendAbs = Math.abs(pubmaticSpend - dspSpend);
    const expectedImpsAbs = sum(list, 'impsDiscrepancyAbs');
    const actualImpsAbs = Math.abs(pubmaticImps - dspImps);

    // 允许 0.01 的舍入误差
    const spendMismatch = Math.abs(expectedSpendAbs - actualSpendAbs) > 0.01;
    const impsMismatch = Math.abs(expectedImpsAbs - actualImpsAbs) > 1; // 曝光数用 1

    if (spendMismatch || impsMismatch) {
      console.warn(`[aggregateByDsp] Data integrity check failed for ${dsp}:`, {
        spendMismatch, expectedSpendAbs, actualSpendAbs,
        impsMismatch, expectedImpsAbs, actualImpsAbs,
      });
    }

    return {
      dsp,
      publishers: new Set(list.map((r) => r.publisherId)).size,
      rows: list.length,
      pubmaticSpend,
      dspSpend,
      pubmaticImps,
      dspImps,
      spendDiscrepancyPct: pubmaticSpend !== 0 ? (pubmaticSpend - dspSpend) / pubmaticSpend : null,
      discrepancyRate: pubmaticImps !== 0 ? (pubmaticImps - dspImps) / pubmaticImps : null,
    };
  });

  return result.sort((a, b) => Math.abs(b.spendDiscrepancyPct ?? 0) - Math.abs(a.spendDiscrepancyPct ?? 0));
}

/** Top N by DSP Partner Spend */
export const getTopSpenders = (rows: DiscrepancyRow[], n = DISCREPANCY_CONFIG.topSpendersCount): DiscrepancyRow[] =>
  [...rows].sort((a, b) => (b.dspSpend ?? 0) - (a.dspSpend ?? 0)).slice(0, n);

/** 高亮：|Spend| 或 |Imps| discrepancy 超过阈值，按 Spend% 降序、DSP Spend 降序 */
export const getHighlights = (rows: DiscrepancyRow[]): DiscrepancyRow[] =>
  rows
    .filter((r) =>
      (r.spendDiscrepancyPct !== null && Math.abs(r.spendDiscrepancyPct) > DISCREPANCY_CONFIG.highlightThreshold) ||
      (r.discrepancyRate !== null && Math.abs(r.discrepancyRate) > DISCREPANCY_CONFIG.highlightThreshold))
    .sort((a, b) =>
      ((b.spendDiscrepancyPct ?? -1e15) - (a.spendDiscrepancyPct ?? -1e15)) ||
      ((b.dspSpend ?? 0) - (a.dspSpend ?? 0)));

/** 无 LLM 时的英文结构化摘要（与 Python generate_structured_summary 对齐） */
export function generateStructuredSummary(rows: DiscrepancyRow[], dateLabel: string): string {
  if (!rows.length) {
    return 'No data was returned for this run. Please verify API credentials and publisher IDs.';
  }
  const publishers = new Set(rows.map((r) => r.publisherId)).size;
  const dsps = new Set(rows.map((r) => r.dsp)).size;
  const dspSummary = aggregateByDsp(rows);
  const topSpenders = getTopSpenders(rows);
  const highlights = getHighlights(rows);
  const thresholdPct = DISCREPANCY_CONFIG.highlightThreshold * 100;

  const lines: string[] = [
    `Report date: ${dateLabel}`,
    `Monitoring ${publishers} publishers and ${dsps} DSPs across ${rows.length} rows (low/no spend rows filtered out).`,
    `Highlight threshold: absolute Spend or Impressions Discrepancy > ${thresholdPct.toFixed(0)}%.`,
    '',
    'Top DSPs by absolute Spend Discrepancy (team-wide aggregated):',
  ];
  for (const r of dspSummary.slice(0, 5)) {
    lines.push(`• ${r.dsp} — Spend Discrepancy ${fmtPct(r.spendDiscrepancyPct)} (PM $${fmtNum(r.pubmaticSpend)} vs DSP $${fmtNum(r.dspSpend)})`);
  }
  lines.push('', 'Top 20 Spenders by DSP Partner Spend:');
  for (const r of topSpenders.slice(0, 5)) {
    const name = r.publisherName ? ` (${r.publisherName})` : '';
    lines.push(`• Publisher ${r.publisherId}${name} / ${r.dsp} — DSP Spend $${fmtNum(r.dspSpend)} — Spend Discrepancy ${fmtPct(r.spendDiscrepancyPct)}`);
  }
  if (!highlights.length) {
    lines.push('', '✅ No publisher/DSP combinations exceed the ±5% Spend or Impressions Discrepancy threshold.');
  } else {
    lines.push('', `⚠️ ${highlights.length} publisher/DSP combination(s) exceed ±${thresholdPct.toFixed(0)}% Spend or Impressions Discrepancy:`);
    for (const r of highlights.slice(0, 10)) {
      const name = r.publisherName ? ` (${r.publisherName})` : '';
      lines.push(`• Publisher ${r.publisherId}${name} / ${r.dsp} — Spend ${fmtPct(r.spendDiscrepancyPct)}, Imps ${fmtPct(r.discrepancyRate)} (DSP Spend $${fmtNum(r.dspSpend)})`);
    }
    if (highlights.length > 10) lines.push(`... and ${highlights.length - 10} more. See the Highlight section.`);
  }
  return lines.join('\n');
}

/** 导出 CSV（原始明细，列名与内部字段一致） */
export function rowsToCsv(rows: DiscrepancyRow[]): string {
  const fields: (keyof DiscrepancyRow)[] = [
    'reportDate', 'publisherId', 'publisherName', 'integration', 'region', 'dspId', 'dsp',
    'pubmaticSpend', 'dspSpend', 'spendDiscrepancyAbs', 'spendDiscrepancyPct',
    'pubmaticImps', 'dspImps', 'impsDiscrepancyAbs', 'discrepancyRate',
    'mtdSpendDiscrepancyPct', 'netMarginPct', 'publisherRevenue', 'needsAttention',
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = fields.join(',');
  const body = rows.map((r) => fields.map((f) => esc(r[f])).join(',')).join('\n');
  return `${header}\n${body}`;
}

/** 验证聚合数据的一致性：检查百分比计算 */
export function validateAggregateConsistency(
  rows: DiscrepancyRow[],
  summary: DspSummaryRow[]
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  // 检查：所有行的 PubMatic Spend 之和 应该等于 summary 中所有 DSP 的 PubMatic Spend 之和
  const totalRowSpend = rows.reduce((sum, r) => sum + (r.pubmaticSpend ?? 0), 0);
  const totalSummarySpend = summary.reduce((sum, s) => sum + s.pubmaticSpend, 0);
  if (Math.abs(totalRowSpend - totalSummarySpend) > 0.01) {
    issues.push(
      `PubMatic Spend mismatch: rows total $${totalRowSpend.toFixed(2)}, summary total $${totalSummarySpend.toFixed(2)}`
    );
  }

  // 检查：所有行的 DSP Spend 之和 应该等于 summary 中所有 DSP 的 DSP Spend 之和
  const totalRowDspSpend = rows.reduce((sum, r) => sum + (r.dspSpend ?? 0), 0);
  const totalSummaryDspSpend = summary.reduce((sum, s) => sum + s.dspSpend, 0);
  if (Math.abs(totalRowDspSpend - totalSummaryDspSpend) > 0.01) {
    issues.push(
      `DSP Spend mismatch: rows total $${totalRowDspSpend.toFixed(2)}, summary total $${totalSummaryDspSpend.toFixed(2)}`
    );
  }

  // 检查：所有行的 PubMatic Imps 之和 应该等于 summary 中所有 DSP 的 PubMatic Imps 之和
  const totalRowImps = rows.reduce((sum, r) => sum + (r.pubmaticImps ?? 0), 0);
  const totalSummaryImps = summary.reduce((sum, s) => sum + s.pubmaticImps, 0);
  if (Math.abs(totalRowImps - totalSummaryImps) > 1) {
    issues.push(`PubMatic Imps mismatch: rows total ${totalRowImps}, summary total ${totalSummaryImps}`);
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/** 报告可用的最新日期（T - dataLatencyDays），返回 YYYY-MM-DD */
export function getLatestAvailableDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - DISCREPANCY_CONFIG.dataLatencyDays);
  return d.toISOString().slice(0, 10);
}
