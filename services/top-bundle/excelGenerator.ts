// ─────────────────────────────────────────────
// Multi-sheet XLSX export (browser download via XLSX.writeFile).
// ─────────────────────────────────────────────
import * as XLSX from 'xlsx';
import { AggRow, BundleRow, PartnerRow, TOP_BUNDLE_CONFIG } from './types';
import { AnalysisMetrics, AdFormatGroup, BundleGroup, fmtCurrency, fmtEcpm } from './dataProcessor';
import { ReportSummaries } from './reportBuilder';
import { DayOverDay, BundleChange, changeArrow } from './history';

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (v: number, base: number) => (base > 0 ? r2((v / base) * 100) : 0);

export class TopBundleExcel {
  static generate(
    rows: BundleRow[],
    summaries: ReportSummaries,
    partner: PartnerRow[],
    metrics: AnalysisMetrics,
    dateLabel: string,
    dayOverDay: DayOverDay | null = null,
    changeMap: Record<string, BundleChange> = {},
  ): string {
    const wb = XLSX.utils.book_new();
    const ia = metrics.inAppSpend;

    this.summarySheet(wb, metrics, dateLabel);
    this.publisherSheet(wb, summaries.topPublishers, ia);
    this.aggSheet(wb, 'By Region', summaries.byRegion, ['region'], ['Region'], ia);
    this.aggSheet(wb, 'By POD', summaries.byPod, ['pod', 'region'], ['POD', 'Region'], ia);
    this.aggSheet(wb, 'Top Bundles', summaries.topBundles, ['bundle', 'appName', 'platform'], ['Bundle', 'App', 'Platform'], ia, changeMap);
    this.aggSheet(wb, 'By Country', summaries.byCountry, ['country'], ['Country'], ia);
    this.aggSheet(wb, 'By DSP', summaries.byDsp, ['dsp'], ['DSP'], ia);
    this.pivotSheet(wb, summaries.adFormatPivot);
    this.bundlePublisherSheet(wb, summaries.bundlePublisher, metrics.inAppPmr);
    this.dayOverDaySheet(wb, dayOverDay);
    this.partnerSheet(wb, partner);
    this.rawSheets(wb, rows);

    const fileName = `Bundle_Level_Analysis_${dateLabel}.xlsx`;
    XLSX.writeFile(wb, fileName);
    return fileName;
  }

  /** Standalone, partner-safe workbook: one sheet, bundle × country + eCPM, no spend/DSP. */
  static generatePartner(partner: PartnerRow[], dateLabel: string): string {
    const wb = XLSX.utils.book_new();
    this.partnerSheet(wb, partner);
    const fileName = `Bundle_List_to_Share_${dateLabel}.xlsx`;
    XLSX.writeFile(wb, fileName);
    return fileName;
  }

  private static summarySheet(wb: XLSX.WorkBook, m: AnalysisMetrics, dateLabel: string): void {
    const data = [
      ['DoD Performance Change Analysis'],
      ['Report date', dateLabel],
      ['Generated', new Date().toLocaleString()],
      [''],
      ['In-app DSP spend', fmtCurrency(m.inAppSpend)],
      ['PMR (PubMatic revenue)', fmtCurrency(m.totalPmr)],
      ['Publisher revenue', fmtCurrency(m.totalRevenue)],
      ['Distinct in-app bundles', m.distinctBundles],
      ['Top bundle', `${m.topBundleName} (${fmtCurrency(m.topBundleSpend)})`],
    ];
    const sheet = XLSX.utils.aoa_to_sheet(data);
    sheet['!cols'] = [{ wch: 28 }, { wch: 36 }];
    XLSX.utils.book_append_sheet(wb, sheet, 'Summary');
  }

  private static publisherSheet(wb: XLSX.WorkBook, rows: AggRow[], inAppSpend: number): void {
    const header = ['Publisher', 'DSP Spend', 'Contribution %', 'PMR (PubMatic rev)', 'Publisher Revenue', 'eCPM'];
    const data: (string | number)[][] = [header];
    for (const r of rows) {
      data.push([String(r.publisher ?? ''), r2(r.spend), pct(r.spend, inAppSpend), r2(r.pmr), r2(r.revenue), r2(r.ecpm)]);
    }
    const sheet = XLSX.utils.aoa_to_sheet(data);
    sheet['!cols'] = [{ wch: 30 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, sheet, 'Top Publishers');
  }

  private static aggSheet(
    wb: XLSX.WorkBook, name: string, rows: AggRow[],
    keys: (keyof AggRow)[], keyLabels: string[], inAppSpend: number,
    changeMap?: Record<string, BundleChange>,
  ): void {
    const header = [...keyLabels, 'DSP Spend', 'Contribution %', 'PMR', 'eCPM', ...(changeMap ? ['vs prev'] : [])];
    const data: (string | number)[][] = [header];
    for (const r of rows) {
      const row: (string | number)[] = [...keys.map((k) => String((r as any)[k] ?? '')), r2(r.spend), pct(r.spend, inAppSpend), r2(r.pmr), r2(r.ecpm)];
      if (changeMap) row.push(changeArrow(changeMap[String((r as any)[keys[0]] ?? '')]));
      data.push(row);
    }
    const sheet = XLSX.utils.aoa_to_sheet(data);
    sheet['!cols'] = Array(header.length).fill({ wch: 18 });
    XLSX.utils.book_append_sheet(wb, sheet, name);
  }

  private static pivotSheet(wb: XLSX.WorkBook, groups: AdFormatGroup[]): void {
    const header = ['Ad Format / Size', 'DSP Spend', 'PMR', 'PMR %', 'eCPM'];
    const data: (string | number)[][] = [header];
    for (const g of groups) {
      data.push([g.adFormat, r2(g.spend), r2(g.pmr), r2(g.pmrShare * 100), r2(g.ecpm)]);
      for (const s of g.sizes) data.push([`  → ${s.adSize}`, r2(s.spend), r2(s.pmr), r2(s.pmrShareOfFormat * 100), r2(s.ecpm)]);
    }
    const sheet = XLSX.utils.aoa_to_sheet(data);
    sheet['!cols'] = [{ wch: 30 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, sheet, 'By Ad Format & Size');
  }

  private static bundlePublisherSheet(wb: XLSX.WorkBook, groups: BundleGroup[], totalPmr: number): void {
    const header = ['App / Publisher', 'Bundle', 'Ad Formats', 'PMR % of bundle', 'DSP Spend', 'PMR', 'PMR %', 'eCPM'];
    const data: (string | number)[][] = [header];
    for (const g of groups) {
      data.push([g.appName, g.bundle, '', '', r2(g.spend), r2(g.pmr), pct(g.pmr, totalPmr), r2(g.ecpm)]);
      for (const r of g.rows) {
        data.push([`  → ${r.publisher}`, '', r.formats.join(', '), r2(r.pmrShareOfBundle * 100), r2(r.spend), r2(r.pmr), '', r2(r.ecpm)]);
      }
    }
    const sheet = XLSX.utils.aoa_to_sheet(data);
    sheet['!cols'] = [{ wch: 34 }, { wch: 28 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, sheet, 'Bundle & Publisher');
  }

  private static partnerSheet(wb: XLSX.WorkBook, partner: PartnerRow[]): void {
    const header = ['Bundle ID', 'App Name', 'Platform', 'Country', 'eCPM']; // no spend / DSP
    const data: (string | number)[][] = [header, ...partner.map((p) => [p.bundle, p.appName, p.platform, p.country, r2(p.ecpm)])];
    const sheet = XLSX.utils.aoa_to_sheet(data);
    sheet['!cols'] = [{ wch: 30 }, { wch: 34 }, { wch: 18 }, { wch: 18 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, sheet, 'Bundle List to Share');
  }

  private static dayOverDaySheet(wb: XLSX.WorkBook, dod: DayOverDay | null): void {
    const data: (string | number)[][] = [];
    if (!dod) {
      data.push(['No prior day on record — this run is the baseline.']);
    } else {
      data.push([`Top ${dod.topN} in-app bundles vs ${dod.prevDate}`], []);
      data.push([`New to top ${dod.topN} (${dod.newEntrants.length})`, 'Bundle']);
      for (const b of dod.newEntrants) data.push([b.appName, b.bundle]);
      data.push([], [`Dropped out (${dod.dropped.length})`, 'Bundle']);
      for (const b of dod.dropped) data.push([b.appName, b.bundle]);
      data.push([], ['Biggest rank moves', 'Bundle', 'From', 'To', 'Delta']);
      for (const m of dod.movers) data.push([m.appName, m.bundle, m.from, m.to, m.delta]);
    }
    const sheet = XLSX.utils.aoa_to_sheet(data);
    sheet['!cols'] = [{ wch: 34 }, { wch: 30 }, { wch: 8 }, { wch: 8 }, { wch: 8 }];
    XLSX.utils.book_append_sheet(wb, sheet, 'Day-over-Day');
  }

  private static rawSheets(wb: XLSX.WorkBook, rows: BundleRow[]): void {
    const header = [
      'Bundle', 'App', 'Platform', 'Publisher', 'Publisher Id', 'DSP', 'Region', 'POD', 'Country',
      'Ad Format', 'Ad Size', 'DSP Spend', 'PMR', 'Revenue', 'eCPM', 'Paid Impressions',
    ];
    const toRow = (r: BundleRow) => [
      r.bundle ?? '', r.appName, r.platform, r.publisher ?? '', r.publisherId ?? '', r.dsp ?? '',
      r.region ?? '', r.pod ?? '', r.country ?? '', r.adFormat ?? '', r.adSize ?? '',
      r2(r.spend), r2(r.pmr), r2(r.revenue), r2(r.ecpm), Math.round(r.paidImpressions),
    ];
    const perSheet = TOP_BUNDLE_CONFIG.excelMaxRows - 1;
    if (rows.length <= perSheet) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows.map(toRow)]), 'Raw');
      return;
    }
    for (let i = 0, part = 1; i < rows.length; i += perSheet, part++) {
      const chunk = rows.slice(i, i + perSheet);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...chunk.map(toRow)]), part === 1 ? 'Raw' : `Raw (${part})`);
    }
  }
}
