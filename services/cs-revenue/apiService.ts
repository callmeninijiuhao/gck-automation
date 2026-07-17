import { RevenueDataPoint } from '@/types';

export interface PublisherFetchError {
  publisherId: string;
  publisherName: string;
  /** HTTP 状态码；网络层错误（如超时）时为 undefined */
  statusCode?: number;
  error: string;
}

/** 带 HTTP 状态码的 API 错误 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public reason: string
  ) {
    super(`API Error ${status}: ${reason}`);
    this.name = 'ApiError';
  }
}

/** 从上游响应体里提取人类可读的错误原因 */
const extractErrorReason = (text: string): string => {
  try {
    const j = JSON.parse(text);
    return (
      j.message ||
      j.errorMessage ||
      (typeof j.error === 'string' ? j.error : j.error?.message) ||
      j.errors?.[0]?.message ||
      text
    );
  } catch {
    return text;
  }
};

interface APIRawResponse {
  data: Array<{
    appDomain: string;
    dspId: string;
    dspName: string;
    date: string;
    revenue: number;
    paidImpressions: number;
    ecpm: number;
  }>;
}

export class CSRevenueAPIService {
  private baseUrl = 'https://api.pubmatic.com/v1/analytics/data/publisher';
  private proxyUrl = 'http://localhost:3001/proxy';
  private token: string;
  private useProxy = true; // 使用代理

  constructor(token: string) {
    this.token = token;
  }

  /**
   * 从 API 拉取单个 Publisher 的收入数据
   */
  async fetchPublisherRevenue(
    publisherId: string,
    publisherName: string,
    fromDate: string,
    toDate: string
  ): Promise<RevenueDataPoint[]> {
    try {
      const apiUrl = `${this.baseUrl}/${publisherId}?fromDate=${encodeURIComponent(
        fromDate
      )}&toDate=${encodeURIComponent(
        toDate
      )}&dimensions=appDomain,dspId,date&metrics=revenue,paidImpressions,ecpm`;

      // 决定是否使用代理
      const finalUrl = this.useProxy
        ? `${this.proxyUrl}?url=${encodeURIComponent(apiUrl)}`
        : apiUrl;

      console.log(`[API] Fetching ${publisherName} (${publisherId})`);
      console.log(`[API] Using ${this.useProxy ? 'PROXY' : 'DIRECT'} - URL: ${apiUrl}`);

      const response = await fetch(finalUrl, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
      });

      console.log(`[API] Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[API] Error response:`, errorText);
        throw new ApiError(response.status, extractErrorReason(errorText));
      }

      const apiData = await response.json();
      console.log(`[API] Raw response for ${publisherName}:`, apiData);

      // 检查响应结构
      let records = apiData.data;
      if (!records && apiData.records) {
        records = apiData.records;
      }
      if (!records && Array.isArray(apiData)) {
        records = apiData;
      }

      console.log(`[API] Parsed records count: ${records?.length || 0}`);

      if (!records || records.length === 0) {
        console.warn(`[API] No data returned for publisher ${publisherId}`);
        return [];
      }

      // 转换 API 响应为标准数据格式
      return records.map((item: any) => {
        const revenue = Number(item.revenue) || 0;
        const impressions = Number(item.paidImpressions || item.impression || item.impressions) || 0;
        const eCPM = item.ecpm || item.eCPM || (impressions > 0 ? (revenue / impressions) * 1000 : 0);

        return {
          publisherId,
          publisherName,
          appDomain: item.appDomain || item.domain || '',
          dspId: item.dspId || item.dsp_id || '',
          dspName: item.dspName || item.dsp_name || '',
          date: item.date || '',
          revenue,
          paidImpressions: impressions,
          eCPM: Number(eCPM) || 0,
        };
      });
    } catch (error) {
      console.error(
        `[API] Error fetching revenue data for publisher ${publisherId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * 批量拉取多个 Publisher 的数据
   * @param publishers - Publisher ID 和 Name 的列表
   * @param fromDate - ISO 格式的开始日期
   * @param toDate - ISO 格式的结束日期
   * @param onProgress - 进度回调函数
   * @returns 成功的数据 + 每个失败 publisher 的错误详情
   */
  async fetchMultiplePublishers(
    publishers: Array<{ id: string; name: string }>,
    fromDate: string,
    toDate: string,
    onProgress?: (current: number, total: number, message: string) => void
  ): Promise<{ data: RevenueDataPoint[]; errors: PublisherFetchError[] }> {
    const allData: RevenueDataPoint[] = [];
    const errors: PublisherFetchError[] = [];

    // 并发控制：同时最多 3 个请求
    const concurrency = 3;
    const queue = [...publishers];

    const worker = async () => {
      while (queue.length > 0) {
        const publisher = queue.shift();
        if (!publisher) break;

        const processed = publishers.length - queue.length;
        onProgress?.(
          processed,
          publishers.length,
          `Processing ${publisher.name} (${processed}/${publishers.length})`
        );

        try {
          const data = await this.fetchPublisherRevenue(
            publisher.id,
            publisher.name,
            fromDate,
            toDate
          );
          allData.push(...data);
        } catch (error) {
          errors.push({
            publisherId: publisher.id,
            publisherName: publisher.name,
            statusCode: error instanceof ApiError ? error.status : undefined,
            error:
              error instanceof ApiError
                ? error.reason
                : error instanceof Error
                  ? error.message
                  : 'Unknown error',
          });
        }
      }
    };

    // 启动多个 worker
    await Promise.all(
      Array.from({ length: concurrency }, () => worker())
    );

    if (errors.length > 0) {
      console.warn('Some publishers failed to fetch:', errors);
    }

    return { data: allData, errors };
  }
}
