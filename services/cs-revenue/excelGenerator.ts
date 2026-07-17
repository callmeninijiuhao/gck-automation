import * as XLSX from 'xlsx';
import {
  RevenueDataPoint,
  PivotTableData,
  DomainLevelMetrics,
} from '@/types';
import { CSRevenueDataProcessor } from './dataProcessor';

export class ExcelGenerator {
  /**
   * 生成完整的 Excel 文件（5 张工作表）
   */
  static generateExcel(
    rawData: RevenueDataPoint[],
    pivotTableData: PivotTableData,
    metrics: DomainLevelMetrics,
    dateRange: [string, string]
  ): void {
    const workbook = XLSX.utils.book_new();

    // Sheet 1: Summary（仪表板）
    this.addSummarySheet(workbook, metrics, dateRange);

    // Sheet 2: Pivot Table（交互透视表）
    this.addPivotTableSheet(workbook, pivotTableData);

    // Sheet 3: Time Series（时间序列明细）
    this.addTimeSeriesSheet(workbook, rawData);

    // Sheet 4: Publisher Detail（发行商详情）
    this.addPublisherDetailSheet(workbook, rawData);

    // Sheet 5: DSP Analysis（DSP 分析）
    this.addDSPAnalysisSheet(workbook, rawData);

    // 导出文件
    const fileName = `Domain_Revenue_Report_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(workbook, fileName);
  }

  /**
   * Sheet 1: Summary（总结仪表板）
   */
  private static addSummarySheet(
    workbook: XLSX.WorkBook,
    metrics: DomainLevelMetrics,
    dateRange: [string, string]
  ): void {
    const summaryData = [
      ['Domain Level Revenue Intelligence Report'],
      [''],
      ['Report Period', `${dateRange[0]} to ${dateRange[1]}`],
      ['Generated Date', new Date().toLocaleString()],
      [''],
      ['Key Metrics'],
      ['Total Revenue', CSRevenueDataProcessor.formatCurrency(metrics.totalRevenue)],
      ['Total Impressions', CSRevenueDataProcessor.formatNumber(metrics.totalImpressions)],
      ['Average eCPM', CSRevenueDataProcessor.formatECPM(metrics.averageECPM)],
      [''],
      ['Coverage'],
      ['Domains', metrics.domainCount],
      ['DSPs', metrics.dspCount],
      ['Publishers', metrics.publisherCount],
    ];

    const sheet = XLSX.utils.aoa_to_sheet(summaryData);
    sheet['!cols'] = [{ wch: 25 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(workbook, sheet, 'Summary');
  }

  /**
   * Sheet 2: Pivot Table（交互透视表 - Domain x DSP）
   */
  private static addPivotTableSheet(
    workbook: XLSX.WorkBook,
    pivotTableData: PivotTableData
  ): void {
    // 获取所有列（DSP）
    const allColumns = new Set<string>();
    for (const row of Object.values(pivotTableData)) {
      Object.keys(row).forEach((col) => allColumns.add(col));
    }
    const columns = Array.from(allColumns).sort();

    // 构建表头
    const header = ['Domain', ...columns];
    const data = [header];

    // 填充数据
    for (const [domain, row] of Object.entries(pivotTableData)) {
      const rowData = [domain];
      for (const col of columns) {
        if (row[col]) {
          // 显示 Revenue 和 eCPM
          rowData.push(
            `${CSRevenueDataProcessor.formatCurrency(row[col].revenue)} / ${CSRevenueDataProcessor.formatECPM(row[col].eCPM)}`
          );
        } else {
          rowData.push('-');
        }
      }
      data.push(rowData);
    }

    const sheet = XLSX.utils.aoa_to_sheet(data);
    sheet['!cols'] = Array(columns.length + 1).fill({ wch: 20 });
    XLSX.utils.book_append_sheet(workbook, sheet, 'Pivot Table');
  }

  /**
   * Sheet 3: Time Series（时间序列明细）
   */
  private static addTimeSeriesSheet(
    workbook: XLSX.WorkBook,
    rawData: RevenueDataPoint[]
  ): void {
    const header = [
      'Date',
      'Domain',
      'DSP',
      'Publisher ID',
      'Publisher Name',
      'Revenue',
      'Impressions',
      'eCPM',
    ];

    const data = [header];
    for (const item of rawData) {
      data.push([
        item.date,
        item.appDomain,
        item.dspName,
        item.publisherId,
        item.publisherName,
        CSRevenueDataProcessor.formatCurrency(item.revenue),
        CSRevenueDataProcessor.formatNumber(item.paidImpressions),
        CSRevenueDataProcessor.formatECPM(item.eCPM),
      ]);
    }

    const sheet = XLSX.utils.aoa_to_sheet(data);
    sheet['!cols'] = Array(8).fill({ wch: 18 });
    XLSX.utils.book_append_sheet(workbook, sheet, 'Time Series');
  }

  /**
   * Sheet 4: Publisher Detail（发行商详情）
   */
  private static addPublisherDetailSheet(
    workbook: XLSX.WorkBook,
    rawData: RevenueDataPoint[]
  ): void {
    // 按 Publisher 聚合
    const publisherMap = new Map<
      string,
      {
        name: string;
        domains: Set<string>;
        revenue: number;
        impressions: number;
      }
    >();

    for (const item of rawData) {
      if (!publisherMap.has(item.publisherId)) {
        publisherMap.set(item.publisherId, {
          name: item.publisherName,
          domains: new Set(),
          revenue: 0,
          impressions: 0,
        });
      }

      const pub = publisherMap.get(item.publisherId)!;
      pub.domains.add(item.appDomain);
      pub.revenue += item.revenue;
      pub.impressions += item.paidImpressions;
    }

    const header = [
      'Publisher ID',
      'Publisher Name',
      'Domains',
      'Total Revenue',
      'Total Impressions',
      'eCPM',
    ];
    const data: (string | number)[][] = [header];

    for (const [id, pub] of publisherMap) {
      const eCPM = CSRevenueDataProcessor.calculateECPM(
        pub.revenue,
        pub.impressions
      );
      data.push([
        id,
        pub.name,
        pub.domains.size,
        CSRevenueDataProcessor.formatCurrency(pub.revenue),
        CSRevenueDataProcessor.formatNumber(pub.impressions),
        CSRevenueDataProcessor.formatECPM(eCPM),
      ]);
    }

    const sheet = XLSX.utils.aoa_to_sheet(data);
    sheet['!cols'] = Array(6).fill({ wch: 18 });
    XLSX.utils.book_append_sheet(workbook, sheet, 'Publisher Detail');
  }

  /**
   * Sheet 5: DSP Analysis（DSP 分析）
   */
  private static addDSPAnalysisSheet(
    workbook: XLSX.WorkBook,
    rawData: RevenueDataPoint[]
  ): void {
    // 按 DSP 聚合
    const dspMap = new Map<
      string,
      {
        name: string;
        domains: Set<string>;
        revenue: number;
        impressions: number;
      }
    >();

    for (const item of rawData) {
      if (!dspMap.has(item.dspId)) {
        dspMap.set(item.dspId, {
          name: item.dspName,
          domains: new Set(),
          revenue: 0,
          impressions: 0,
        });
      }

      const dsp = dspMap.get(item.dspId)!;
      dsp.domains.add(item.appDomain);
      dsp.revenue += item.revenue;
      dsp.impressions += item.paidImpressions;
    }

    // 排序：按 Revenue 降序
    const sorted = Array.from(dspMap.entries())
      .sort((a, b) => b[1].revenue - a[1].revenue);

    const header = ['DSP ID', 'DSP Name', 'Domains', 'Total Revenue', 'Total Impressions', 'eCPM'];
    const data: (string | number)[][] = [header];

    for (const [id, dsp] of sorted) {
      const eCPM = CSRevenueDataProcessor.calculateECPM(
        dsp.revenue,
        dsp.impressions
      );
      data.push([
        id,
        dsp.name,
        dsp.domains.size,
        CSRevenueDataProcessor.formatCurrency(dsp.revenue),
        CSRevenueDataProcessor.formatNumber(dsp.impressions),
        CSRevenueDataProcessor.formatECPM(eCPM),
      ]);
    }

    const sheet = XLSX.utils.aoa_to_sheet(data);
    sheet['!cols'] = Array(6).fill({ wch: 18 });
    XLSX.utils.book_append_sheet(workbook, sheet, 'DSP Analysis');
  }
}
