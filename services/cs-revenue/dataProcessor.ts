import {
  RevenueDataPoint,
  PivotTableData,
  PivotTableConfig,
  AggregatedData,
  DomainLevelMetrics,
} from '@/types';

export class CSRevenueDataProcessor {
  /**
   * 计算 eCPM（有些 API 可能没返回，需要手动计算）
   */
  static calculateECPM(revenue: number, impressions: number): number {
    if (impressions === 0) return 0;
    return (revenue / impressions) * 1000;
  }

  /**
   * 从原始数据计算关键指标
   */
  static calculateMetrics(data: RevenueDataPoint[]): DomainLevelMetrics {
    if (data.length === 0) {
      return {
        totalRevenue: 0,
        totalImpressions: 0,
        averageECPM: 0,
        dspCount: 0,
        domainCount: 0,
        publisherCount: 0,
      };
    }

    const totalRevenue = data.reduce((sum, d) => sum + d.revenue, 0);
    const totalImpressions = data.reduce((sum, d) => sum + d.paidImpressions, 0);
    const averageECPM = this.calculateECPM(totalRevenue, totalImpressions);

    const dspSet = new Set(data.map((d) => d.dspId));
    const domainSet = new Set(data.map((d) => d.appDomain));
    const publisherSet = new Set(data.map((d) => d.publisherId));

    return {
      totalRevenue,
      totalImpressions,
      averageECPM,
      dspCount: dspSet.size,
      domainCount: domainSet.size,
      publisherCount: publisherSet.size,
    };
  }

  /**
   * 按维度聚合数据
   */
  private static aggregateByDimension(
    data: RevenueDataPoint[],
    groupByField: keyof RevenueDataPoint
  ): Map<string, RevenueDataPoint[]> {
    const grouped = new Map<string, RevenueDataPoint[]>();

    for (const item of data) {
      const key = String(item[groupByField]);
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(item);
    }

    return grouped;
  }

  /**
   * 根据行列配置生成透视表
   */
  static generatePivotTable(
    data: RevenueDataPoint[],
    config: PivotTableConfig
  ): PivotTableData {
    const pivotData: PivotTableData = {};

    // 先按行维度分组
    const rowGroups = this.aggregateByDimension(
      data,
      config.rows as keyof RevenueDataPoint
    );

    for (const [rowKey, rowData] of rowGroups) {
      pivotData[rowKey] = {};

      // 再按列维度分组
      const colGroups = this.aggregateByDimension(
        rowData,
        config.columns as keyof RevenueDataPoint
      );

      for (const [colKey, colData] of colGroups) {
        const revenue = colData.reduce((sum, d) => sum + d.revenue, 0);
        const impressions = colData.reduce(
          (sum, d) => sum + d.paidImpressions,
          0
        );
        const eCPM = this.calculateECPM(revenue, impressions);

        pivotData[rowKey][colKey] = {
          revenue,
          paidImpressions: impressions,
          eCPM,
        };
      }
    }

    return pivotData;
  }

  /**
   * 添加合计行和列到透视表
   */
  static addTotalsTopivot(pivotData: PivotTableData): PivotTableData {
    const result = { ...pivotData };
    const totals: { [key: string]: AggregatedData } = {};

    // 计算每列的合计
    const allCols = new Set<string>();
    for (const row of Object.values(pivotData)) {
      Object.keys(row).forEach((col) => allCols.add(col));
    }

    for (const col of allCols) {
      let colRevenue = 0;
      let colImpressions = 0;

      for (const row of Object.values(pivotData)) {
        if (row[col]) {
          colRevenue += row[col].revenue;
          colImpressions += row[col].paidImpressions;
        }
      }

      totals[col] = {
        revenue: colRevenue,
        paidImpressions: colImpressions,
        eCPM: this.calculateECPM(colRevenue, colImpressions),
      };
    }

    // 添加合计行
    result['__TOTAL__'] = totals;

    // 为每行添加合计列
    for (const rowKey of Object.keys(result)) {
      if (rowKey === '__TOTAL__') continue;

      let rowRevenue = 0;
      let rowImpressions = 0;

      for (const cell of Object.values(result[rowKey])) {
        rowRevenue += cell.revenue;
        rowImpressions += cell.paidImpressions;
      }

      result[rowKey]['__TOTAL__'] = {
        revenue: rowRevenue,
        paidImpressions: rowImpressions,
        eCPM: this.calculateECPM(rowRevenue, rowImpressions),
      };
    }

    return result;
  }

  /**
   * 格式化数字为货币
   */
  static formatCurrency(value: number, decimals = 2): string {
    return `$${value.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  }

  /**
   * 格式化 eCPM
   */
  static formatECPM(value: number, decimals = 2): string {
    return `$${value.toFixed(decimals)}`;
  }

  /**
   * 格式化数字
   */
  static formatNumber(value: number): string {
    return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
}
