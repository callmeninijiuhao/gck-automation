import React, { useState } from 'react';
import { Upload, Calendar, Download, RefreshCw } from 'lucide-react';
import { Publisher, RevenueDataPoint, PivotTableConfig, DomainLevelMetrics, PivotTableData } from '@/types';
import { CSRevenueAPIService, PublisherFetchError } from '@/services/cs-revenue/apiService';
import { CSRevenueDataProcessor } from '@/services/cs-revenue/dataProcessor';
import { ExcelGenerator } from '@/services/cs-revenue/excelGenerator';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';

type Step = 'upload' | 'dateRange' | 'loading' | 'results';

// Token 保存在本机 localStorage（每个用户各自的浏览器/客户端）
const TOKEN_STORAGE_KEY = 'gck_pubmatic_api_token';

const loadSavedToken = (): string => {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
};

// ===== 日期工具（本地时区）=====
const toYMD = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const daysAgo = (n: number): Date => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

// 数据最晚可选到昨天
const MAX_DATE = toYMD(daysAgo(1));

interface DatePreset {
  label: string;
  range: () => [string, string];
}

// 常见 HTTP 错误码的中文说明
const STATUS_HINT: Record<number, string> = {
  400: '请求参数有误',
  401: 'Token 无效或已过期',
  403: 'Token 无权访问该 Publisher',
  404: 'Publisher 不存在',
  429: '请求过于频繁，被限流',
  500: '该 Publisher 在此日期段无数据或 ID 无效',
  502: '上游网关错误，可稍后重试',
  504: '上游超时，可缩小日期范围重试',
};

const DATE_PRESETS: DatePreset[] = [
  { label: 'Last 7 Days', range: () => [toYMD(daysAgo(7)), MAX_DATE] },
  { label: 'Last 30 Days', range: () => [toYMD(daysAgo(30)), MAX_DATE] },
  {
    label: 'Month to Date',
    range: () => {
      const y = daysAgo(1);
      return [toYMD(new Date(y.getFullYear(), y.getMonth(), 1)), MAX_DATE];
    },
  },
  {
    label: 'Last Month',
    range: () => {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return [toYMD(first), toYMD(last)];
    },
  },
];

interface LoadingState {
  current: number;
  total: number;
  message: string;
}

const DomainRevenueIntelligence: React.FC = () => {
  const [step, setStep] = useState<Step>('upload');
  const [apiToken, setApiToken] = useState(loadSavedToken);
  const [publishers, setPublishers] = useState<Publisher[]>([]);
  const [dateRange, setDateRange] = useState<[string, string]>(['', '']);
  const [loadingState, setLoadingState] = useState<LoadingState>({ current: 0, total: 0, message: '' });
  const [error, setError] = useState<string | null>(null);

  const [fetchErrors, setFetchErrors] = useState<PublisherFetchError[]>([]);
  const [rawData, setRawData] = useState<RevenueDataPoint[]>([]);
  const [metrics, setMetrics] = useState<DomainLevelMetrics | null>(null);
  const [pivotTableData, setPivotTableData] = useState<PivotTableData>({});
  const [pivotConfig, setPivotConfig] = useState<PivotTableConfig>({
    rows: 'domain',
    columns: 'dspId',
    values: ['revenue', 'eCPM'],
  });

  // ========== Step 1: 文件上传 ==========
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const content = e.target?.result as ArrayBuffer;

        // 判断文件类型
        if (file.name.endsWith('.csv')) {
          // CSV 处理
          const text = new TextDecoder().decode(content);
          parseCSV(text);
        } else if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
          // Excel 处理
          const { read, utils } = await import('xlsx');
          const workbook = read(content, { type: 'array' });
          const worksheet = workbook.Sheets[workbook.SheetNames[0]];
          const data = utils.sheet_to_json(worksheet);
          parseExcel(data);
        } else {
          setError('仅支持 CSV 或 Excel 文件格式');
        }
      } catch (err) {
        setError(`文件解析错误: ${err instanceof Error ? err.message : '未知错误'}`);
      }
    };

    reader.readAsArrayBuffer(file);
  };

  // ===== 模糊列名匹配工具 =====
  // 归一化：小写 + 去掉非字母数字字符（"Publisher Id" / "publisher_id" / "PublisherID" 归一为 publisherid）
  const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

  // 是否像 "publisher"（容忍 publiser / publsher / pub 等拼写变体）
  const isPubLike = (h: string) => h.startsWith('pub') || h.includes('publisher') || h.includes('publiser');

  // 找 ID 列：publisherId / Publisher Id / publiser id / pub id / id
  const findIdIndex = (headers: string[]) => {
    const norm = headers.map(normalizeHeader);
    let idx = norm.findIndex((h) => isPubLike(h) && h.endsWith('id'));
    if (idx === -1) idx = norm.findIndex((h) => h === 'id' || h === 'pubid');
    return idx;
  };

  // 找 Name 列：publisherName / Publisher name / publiser / publisher（列名可能只写了 Publiser）
  const findNameIndex = (headers: string[], idIndex: number) => {
    const norm = headers.map(normalizeHeader);
    let idx = norm.findIndex((h, i) => i !== idIndex && isPubLike(h) && h.includes('name'));
    if (idx === -1) idx = norm.findIndex((h, i) => i !== idIndex && h === 'name');
    // 列名只写了 "Publisher" / "Publiser" 的情况
    if (idx === -1) idx = norm.findIndex((h, i) => i !== idIndex && (h === 'publisher' || h === 'publiser' || h === 'pub'));
    return idx;
  };

  // 解析 CSV 文件
  const parseCSV = (content: string) => {
    try {
      const lines = content.trim().split('\n');
      const header = lines[0].split(',').map((h) => h.trim());

      const idIndex = findIdIndex(header);
      const nameIndex = findNameIndex(header, idIndex);

      if (idIndex === -1) {
        setError(
          '❌ CSV 文件必须包含 Publisher ID 列\n\n' +
          '支持的列名（模糊匹配）:\n' +
          '- publisherId, Publisher Id, publisher_id, Publiser ID, id\n\n' +
          `找到的列: ${header.join(', ')}`
        );
        return;
      }

      // Name 列缺失时不报错，回退为 "Publisher {id}"
      const parsed: Publisher[] = [];
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const parts = lines[i].split(',');
        if (parts.length > idIndex) {
          const id = parts[idIndex].trim();
          const name = nameIndex !== -1 && parts[nameIndex] ? parts[nameIndex].trim() : '';
          if (id) {
            parsed.push({ id, name: name || `Publisher ${id}` });
          }
        }
      }

      if (parsed.length === 0) {
        setError('❌ 未找到有效的 Publisher 数据');
        return;
      }

      setPublishers(parsed);
      setError(null);
      setStep('dateRange');
    } catch (err) {
      setError(`CSV 解析错误: ${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  // 解析 Excel 文件
  const parseExcel = (data: Array<{ [key: string]: any }>) => {
    try {
      if (data.length === 0) {
        setError('❌ Excel 文件为空');
        return;
      }

      // 获取第一行的列名，复用模糊匹配逻辑
      const firstRow = data[0];
      const columns = Object.keys(firstRow);
      const idIndex = findIdIndex(columns);
      const nameIndex = findNameIndex(columns, idIndex);

      if (idIndex === -1) {
        console.log('Available columns:', columns);
        setError(
          '❌ Excel 文件必须包含 Publisher ID 列（支持模糊匹配，如 Publiser ID / publisher_id）\n\n' +
          `找到的列: ${columns.join(', ')}`
        );
        return;
      }

      const idKey = columns[idIndex];
      const nameKey = nameIndex !== -1 ? columns[nameIndex] : null;

      // Name 列缺失时回退为 "Publisher {id}"
      const parsed: Publisher[] = data
        .map((row) => {
          const id = String(row[idKey] ?? '').trim();
          const name = nameKey ? String(row[nameKey] ?? '').trim() : '';
          return { id, name: name || `Publisher ${id}` };
        })
        .filter((p) => p.id && p.id !== 'undefined');

      if (parsed.length === 0) {
        setError('❌ 未找到有效的 Publisher 数据');
        return;
      }

      setPublishers(parsed);
      setError(null);
      setStep('dateRange');
    } catch (err) {
      setError(`Excel 解析错误: ${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  // ========== Step 2: 日期范围选择 ==========
  const handleDateRangeSubmit = async () => {
    if (!dateRange[0] || !dateRange[1]) {
      setError('请选择日期范围');
      return;
    }

    if (dateRange[1] > MAX_DATE) {
      setError(`结束日期最晚只能选到昨天（${MAX_DATE}），之后的数据还未生成`);
      return;
    }

    if (dateRange[0] > dateRange[1]) {
      setError('开始日期不能晚于结束日期');
      return;
    }

    if (!apiToken) {
      setError('请输入 API Token');
      return;
    }

    setStep('loading');
    setError(null);
    setLoadingState({ current: 0, total: publishers.length, message: '准备中...' });

    try {
      const apiService = new CSRevenueAPIService(apiToken);

      // 转换日期格式为 ISO 格式
      const fromDate = `${dateRange[0]}T00:00`;
      const toDate = `${dateRange[1]}T23:59`;

      console.log(`[Main] Starting data fetch with ${publishers.length} publishers`);
      console.log(`[Main] Date range: ${fromDate} to ${toDate}`);
      console.log(`[Main] API Token: ${apiToken.substring(0, 10)}...`);

      // 批量拉取数据
      const { data, errors } = await apiService.fetchMultiplePublishers(
        publishers,
        fromDate,
        toDate,
        (current, total, message) => {
          console.log(`[Progress] ${current}/${total}: ${message}`);
          setLoadingState({ current, total, message });
        }
      );

      console.log(`[Main] Total records fetched: ${data.length}, failed publishers: ${errors.length}`);
      setFetchErrors(errors);

      if (data.length > 0) {
        // 有成功请求 → token 有效，保存到本机供下次使用
        try {
          localStorage.setItem(TOKEN_STORAGE_KEY, apiToken);
        } catch {
          // localStorage 不可用时忽略
        }
      }

      if (data.length === 0) {
        const detail = errors
          .slice(0, 5)
          .map((e) => {
            const code = e.statusCode ?? 'NET';
            const hint = e.statusCode ? STATUS_HINT[e.statusCode] : '网络错误';
            return `• [${code}] ${e.publisherName} (${e.publisherId})${hint ? ` — ${hint}` : ''}\n  ${e.error.slice(0, 150)}`;
          })
          .join('\n');
        setError(
          `❌ 所有 Publisher 都拉取失败（${errors.length}/${publishers.length}）\n\n` +
          `失败详情（前 5 条）:\n${detail}\n\n` +
          `完整错误见代理终端日志。`
        );
        setStep('dateRange');
        return;
      }

      setRawData(data);

      // 计算指标
      const calculatedMetrics = CSRevenueDataProcessor.calculateMetrics(data);
      console.log(`[Main] Calculated metrics:`, calculatedMetrics);
      setMetrics(calculatedMetrics);

      // 生成透视表
      const pivotData = CSRevenueDataProcessor.generatePivotTable(data, pivotConfig);
      const pivotWithTotals = CSRevenueDataProcessor.addTotalsTopivot(pivotData);
      console.log(`[Main] Pivot table generated with ${Object.keys(pivotWithTotals).length} domains`);
      setPivotTableData(pivotWithTotals);

      setStep('results');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : '未知错误';
      console.error(`[Main] Error during data fetch:`, err);
      setError(
        `❌ Data loading failed\n\n` +
        `Error: ${errorMsg}\n\n` +
        `Check browser console (F12) for more details`
      );
      setStep('dateRange');
    }
  };

  // ========== 导出 Excel ==========
  const handleExportExcel = () => {
    if (!metrics) return;
    ExcelGenerator.generateExcel(rawData, pivotTableData, metrics, dateRange);
  };

  // ========== Loading: 拉取进度 ==========
  if (step === 'loading') {
    const pct = loadingState.total > 0
      ? Math.round((loadingState.current / loadingState.total) * 100)
      : 0;
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-pubmatic-text">Domain Level Revenue Intelligence</h1>
          <p className="text-gray-500 mt-2">Fetching data from PubMatic API…</p>
        </div>

        <div className="bg-white p-8 rounded-lg border border-pubmatic-border shadow-sm space-y-4">
          <div className="flex items-center gap-3">
            <RefreshCw size={20} className="text-pubmatic-blue animate-spin" />
            <span className="text-sm font-medium text-pubmatic-text">
              {loadingState.current} / {loadingState.total} publishers
            </span>
            <span className="text-sm text-gray-500">{pct}%</span>
          </div>

          <div className="w-full bg-gray-100 rounded-full h-3">
            <div
              className="bg-pubmatic-blue h-3 rounded-full transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>

          <p className="text-sm text-gray-500">{loadingState.message}</p>
          <p className="text-xs text-gray-400">
            数据量大的 Publisher 单个请求可能需要 1-3 分钟，请耐心等待。失败的 Publisher 不会中断整体流程，结束后会列出。
          </p>
        </div>
      </div>
    );
  }

  // ========== Step 3: 结果展示 ==========
  if (step === 'results' && metrics) {
    return (
      <div className="space-y-6">
        {/* 标题 */}
        <div>
          <h1 className="text-3xl font-bold text-pubmatic-text">Domain Level Revenue Intelligence</h1>
          <p className="text-gray-500 mt-2">
            Report Period: {dateRange[0]} to {dateRange[1]}
          </p>
        </div>

        {/* 部分失败提示 */}
        {fetchErrors.length > 0 && (
          <div className="bg-yellow-50 border border-yellow-300 p-4 rounded-md text-sm text-yellow-800">
            <p className="font-semibold mb-2">
              ⚠️ {fetchErrors.length} 个 Publisher 拉取失败（数据仅包含成功的 {metrics.publisherCount} 个）
            </p>
            <ul className="space-y-1.5">
              {fetchErrors.map((e) => (
                <li key={e.publisherId} className="flex items-start gap-2">
                  <span className="shrink-0 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-xs font-mono font-semibold">
                    {e.statusCode ?? 'NET'}
                  </span>
                  <span>
                    <span className="font-medium">{e.publisherName} ({e.publisherId})</span>
                    {e.statusCode && STATUS_HINT[e.statusCode] && (
                      <span className="text-yellow-700"> — {STATUS_HINT[e.statusCode]}</span>
                    )}
                    <span className="block text-xs text-yellow-700/80 font-mono">
                      {e.error.slice(0, 200)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 关键指标卡片 */}
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-lg border border-pubmatic-border shadow-sm">
            <p className="text-gray-500 text-sm">Total Revenue</p>
            <p className="text-2xl font-bold text-pubmatic-blue mt-2">
              ${(metrics.totalRevenue / 1000).toFixed(1)}K
            </p>
          </div>
          <div className="bg-white p-4 rounded-lg border border-pubmatic-border shadow-sm">
            <p className="text-gray-500 text-sm">Total Impressions</p>
            <p className="text-2xl font-bold text-pubmatic-blue mt-2">
              {(metrics.totalImpressions / 1000000).toFixed(2)}M
            </p>
          </div>
          <div className="bg-white p-4 rounded-lg border border-pubmatic-border shadow-sm">
            <p className="text-gray-500 text-sm">Average eCPM</p>
            <p className="text-2xl font-bold text-pubmatic-blue mt-2">
              ${metrics.averageECPM.toFixed(2)}
            </p>
          </div>
          <div className="bg-white p-4 rounded-lg border border-pubmatic-border shadow-sm">
            <p className="text-gray-500 text-sm">Coverage</p>
            <p className="text-sm text-gray-600 mt-2">
              {metrics.domainCount} Domains | {metrics.dspCount} DSPs | {metrics.publisherCount} Publishers
            </p>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-2">
          <Button onClick={handleExportExcel} className="gap-2">
            <Download size={18} />
            Export Excel
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setStep('upload');
              setPublishers([]);
              setDateRange(['', '']);
              setRawData([]);
              setMetrics(null);
              setPivotTableData({});
              setFetchErrors([]);
            }}
            className="gap-2"
          >
            <RefreshCw size={18} />
            New Report
          </Button>
        </div>

        {/* Pivot Table 预览 */}
        <div className="bg-white p-6 rounded-lg border border-pubmatic-border shadow-sm">
          <h2 className="text-lg font-bold text-pubmatic-text mb-4">Pivot Table (Domain × DSP)</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-pubmatic-border">
                  <th className="text-left p-2 font-semibold bg-pubmatic-gray">Domain</th>
                  {Object.keys(pivotTableData)
                    .filter((k) => k !== '__TOTAL__')
                    .slice(0, 1)
                    .flatMap((domain) =>
                      Object.keys(pivotTableData[domain])
                        .filter((dsp) => dsp !== '__TOTAL__')
                        .slice(0, 5)
                        .map((dsp) => (
                          <th key={`${domain}-${dsp}`} className="text-left p-2 font-semibold bg-pubmatic-gray">
                            {dsp}
                          </th>
                        ))
                    )}
                  <th className="text-left p-2 font-semibold bg-pubmatic-blue text-white">Total</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(pivotTableData)
                  .slice(0, 5)
                  .map(([domain, row]) => (
                    <tr key={domain} className="border-b border-gray-200 hover:bg-pubmatic-lightBlue">
                      <td className="p-2 font-medium">{domain === '__TOTAL__' ? 'TOTAL' : domain}</td>
                      {Object.entries(row)
                        .slice(0, 6)
                        .map(([dsp, data]) => (
                          <td key={`${domain}-${dsp}`} className="p-2 text-gray-600">
                            {dsp === '__TOTAL__' ? (
                              <span className="font-semibold text-pubmatic-blue">
                                ${(data.revenue / 1000).toFixed(1)}K
                              </span>
                            ) : (
                              <span>${(data.revenue / 1000).toFixed(1)}K</span>
                            )}
                          </td>
                        ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500 mt-4 text-center">
            Showing first 5 rows and columns • Export Excel for complete data
          </p>
        </div>
      </div>
    );
  }

  // ========== Step 2: 日期范围选择 ==========
  if (step === 'dateRange') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-pubmatic-text">Domain Level Revenue Intelligence</h1>
          <p className="text-gray-500 mt-2">Step 2: Select Date Range</p>
        </div>

        <div className="bg-white p-6 rounded-lg border border-pubmatic-border shadow-sm space-y-4">
          <div className="bg-blue-50 border border-blue-200 p-3 rounded-md text-sm text-blue-800">
            ⚠️ Data Completeness: Data is complete through yesterday. Today's data updates after 5 PM. Can only select through the day before yesterday.
          </div>

          {/* 快捷日期选择 */}
          <div className="flex flex-wrap gap-2">
            {DATE_PRESETS.map((preset) => {
              const [from, to] = preset.range();
              const active = dateRange[0] === from && dateRange[1] === to;
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setDateRange([from, to])}
                  className={`px-3 py-1.5 text-sm rounded-full border transition ${
                    active
                      ? 'bg-pubmatic-blue text-white border-pubmatic-blue'
                      : 'bg-white text-pubmatic-text border-pubmatic-border hover:bg-pubmatic-lightBlue'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-pubmatic-text mb-2">From Date</label>
              <Input
                type="date"
                max={dateRange[1] || MAX_DATE}
                value={dateRange[0]}
                onChange={(e) => setDateRange([e.target.value, dateRange[1]])}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-pubmatic-text mb-2">To Date</label>
              <Input
                type="date"
                min={dateRange[0] || undefined}
                max={MAX_DATE}
                value={dateRange[1]}
                onChange={(e) => setDateRange([dateRange[0], e.target.value])}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-pubmatic-text mb-2">API Token</label>
            <Input
              type="password"
              placeholder="Enter your PubMatic API Bearer token"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
            />
            <div className="flex items-center justify-between mt-1">
              <p className="text-xs text-gray-500">
                {loadSavedToken()
                  ? '✓ 已自动填入上次保存的 Token（拉取成功后自动更新）'
                  : 'Token 仅保存在本机，拉取成功后自动记住'}
              </p>
              {loadSavedToken() && (
                <button
                  type="button"
                  className="text-xs text-red-500 hover:underline"
                  onClick={() => {
                    try {
                      localStorage.removeItem(TOKEN_STORAGE_KEY);
                    } catch { /* ignore */ }
                    setApiToken('');
                  }}
                >
                  清除已保存 Token
                </button>
              )}
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 p-3 rounded-md text-sm text-red-800">
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-4">
            <Button onClick={handleDateRangeSubmit} className="gap-2">
              <Calendar size={18} />
              Fetch Data
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setStep('upload');
                setPublishers([]);
              }}
            >
              Back
            </Button>
          </div>

          <div className="text-sm text-gray-600 pt-4">
            <p>📋 File Info:</p>
            <p>Publishers: {publishers.length}</p>
          </div>
        </div>
      </div>
    );
  }

  // ========== Step 1: 文件上传 ==========
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-pubmatic-text">Domain Level Revenue Intelligence</h1>
        <p className="text-gray-500 mt-2">Step 1: Upload Publisher List</p>
      </div>

      <div className="bg-white p-6 rounded-lg border border-pubmatic-border shadow-sm space-y-4">
        <div className="border-2 border-dashed border-pubmatic-border rounded-lg p-8 text-center cursor-pointer hover:bg-pubmatic-lightBlue transition">
          <label className="cursor-pointer">
            <div className="flex flex-col items-center gap-2">
              <Upload size={32} className="text-pubmatic-blue" />
              <span className="text-sm font-medium text-pubmatic-text">Click to upload CSV or Excel file</span>
              <span className="text-xs text-gray-500">File must contain: Publisher ID and Publisher Name columns</span>
            </div>
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 p-3 rounded-md text-sm text-red-800 whitespace-pre-wrap font-mono">
            {error}
          </div>
        )}

        {publishers.length > 0 && (
          <div className="bg-green-50 border border-green-200 p-3 rounded-md text-sm text-green-800">
            ✓ Successfully loaded {publishers.length} publishers
          </div>
        )}

        {publishers.length === 0 && (
        <div className="text-sm text-gray-600">
          <p className="font-semibold mb-2">📝 Supported File Formats:</p>

          <p className="mt-3 font-medium">CSV Format:</p>
          <pre className="bg-gray-100 p-2 rounded mt-1 text-xs overflow-x-auto">
publisherId,publisherName
159409,New York Times
159410,CNN
159412,BBC
          </pre>

          <p className="mt-3 font-medium">Excel Format:</p>
          <pre className="bg-gray-100 p-2 rounded mt-1 text-xs overflow-x-auto">
Publisher Id | Publisher name
156512       | Wunderkind, Inc.
157743       | Seedtag Advertising
81564        | EXTE - Rich Audience
          </pre>

          <p className="mt-3 text-xs text-gray-500">
            ✓ Column names are flexible (e.g., "Publisher Id", "publisher_id", "publisherId" all work)
          </p>
        </div>
        )}
      </div>
    </div>
  );
};

export default DomainRevenueIntelligence;
