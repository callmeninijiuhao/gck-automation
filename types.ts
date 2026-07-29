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