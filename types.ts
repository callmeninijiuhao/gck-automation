import React from 'react';

export interface AppData {
  appName: string;
  storeUrl: string;
  developerWebsite: string;
  adsTxtUrl: string;
  adsTxtStatus: 'success' | 'failed' | 'pending';
  adsTxtStatusCode?: number;
}

export interface DeveloperInfo {
  name: string;
  url: string;
  platform: 'Android' | 'iOS';
  totalApps: number;
  address?: string;
}

export interface CrawlerResult {
  developer: DeveloperInfo;
  apps: AppData[];
}

export type LoadingState = 'idle' | 'analyzing_input' | 'crawling_dev_page' | 'validating_ads_txt' | 'complete' | 'error';

export interface NavItem {
  id: string;
  label: string;
  path?: string;
  icon?: React.ComponentType<{ className?: string; size?: number | string }>;
  children?: NavItem[];
}

// =============== Domain Level Revenue Intelligence 类型 ===============

export interface Publisher {
  id: string;
  name: string;
}

export interface RevenueDataPoint {
  publisherId: string;
  publisherName: string;
  appDomain: string;
  dspId: string;
  dspName: string;
  date: string;
  revenue: number;
  paidImpressions: number;
  eCPM: number; // (revenue / paidImpressions) * 1000
}

export interface AggregatedData {
  revenue: number;
  paidImpressions: number;
  eCPM: number;
}

export interface PivotTableData {
  [rowKey: string]: {
    [colKey: string]: AggregatedData;
  };
}

export interface PivotTableConfig {
  rows: 'domain' | 'publisher' | 'dspId' | 'date';
  columns: 'dspId' | 'domain' | 'publisher' | 'date';
  values: ('revenue' | 'eCPM' | 'impression')[];
  filters?: {
    dateRange?: [string, string];
    publisherIds?: string[];
    domains?: string[];
  };
}

export interface DomainLevelMetrics {
  totalRevenue: number;
  totalImpressions: number;
  averageECPM: number;
  dspCount: number;
  domainCount: number;
  publisherCount: number;
}

export interface CSRevenueState {
  publishers: Publisher[];
  rawData: RevenueDataPoint[];
  pivotTableData: PivotTableData;
  metrics: DomainLevelMetrics;
  isLoading: boolean;
  loadingProgress: number;
  loadingMessage: string;
  error: string | null;
  dateRange: [string, string];
  currentPivotConfig: PivotTableConfig;
}