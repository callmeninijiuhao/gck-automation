import Papa from 'papaparse';
import * as XLSX from 'xlsx';

export interface ParsedFileResult {
  headers: string[];
  rows: Record<string, unknown>[];
}

/**
 * Parses a file (CSV or Excel) and returns headers and rows.
 * @param file - The file object to parse.
 * @returns Promise with headers and rows.
 */
export function parseFile(file: File): Promise<ParsedFileResult> {
  const fileName = file.name.toLowerCase();
  if (fileName.endsWith('.csv')) {
    return parseCsv(file);
  } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    return parseExcel(file);
  } else {
    return Promise.reject(new Error('Unsupported file format. Please upload a CSV or Excel (.xlsx, .xls) file.'));
  }
}

/**
 * Parses an Excel (.xlsx or .xls) file.
 * @param file - The file to parse.
 * @returns Promise with headers and rows.
 */
export function parseExcel(file: File): Promise<ParsedFileResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];

        const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as unknown[][];
        if (rawData.length === 0) {
          resolve({ headers: [], rows: [] });
          return;
        }

        const headers = (rawData[0] as unknown[]).map(h =>
          h !== undefined && h !== null ? String(h).trim() : ''
        ).filter(Boolean);

        const rows = rawData.slice(1).map(row => {
          const obj: Record<string, unknown> = {};
          headers.forEach((header, index) => {
            obj[header] = row[index] !== undefined && row[index] !== null ? row[index] : '';
          });
          return obj;
        });

        resolve({ headers, rows });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Parses a CSV file or string using PapaParse.
 * @param target - The file object or string content to parse.
 * @returns Promise with headers and rows.
 */
export function parseCsv(target: File | string): Promise<ParsedFileResult> {
  return new Promise((resolve, reject) => {
    const config: Papa.ParseLocalConfig<Record<string, unknown>, File> = {
      header: true,
      skipEmptyLines: 'greedy',
      complete: (results) => {
        const headers = results.meta.fields || [];
        resolve({
          headers,
          rows: results.data as Record<string, unknown>[]
        });
      },
      error: (error) => {
        reject(error);
      }
    };

    if (target instanceof File) {
      Papa.parse(target, config);
    } else {
      Papa.parse(target, config as unknown as Papa.ParseConfig<Record<string, unknown>>);
    }
  });
}

export interface ColumnMappings {
  dealIdCol: string;
  dealNameCol: string;
  ownerCol: string;
  ownerMetaCol: string;
  pubIdCol: string;
  revenueCol: string;
}

/**
 * Automatically detects column mappings from headers using common patterns.
 * @param headers - The list of column headers from the CSV.
 * @returns Detected mappings.
 */
export function autoDetectMappings(headers: string[]): ColumnMappings {
  const mappings: ColumnMappings = {
    dealIdCol: '',
    dealNameCol: '',
    ownerCol: '',
    ownerMetaCol: '',
    pubIdCol: '',
    revenueCol: ''
  };

  const idPatterns = [
    /deal\s*id/i,
    /^id$/i,
    /ap\s*id/i,
    /package\s*id/i
  ];
  const namePatterns = [/deal\s*name/i, /^name$/i, /ap\s*name/i, /package\s*name/i];
  const ownerPatterns = [
    /^(?!.*metadata).*deal\s*o[wn][nw]er(?!\s*id)(?:\s*name)?$/i,
    /^owner$/i,
    /^onwer$/i,
    /account\s*manager/i,
    /^am$/i,
    /contact/i,
    /email/i
  ];
  const ownerMetaPatterns = [
    /deal\s*metadata\s*deal\s*owner/i,
    /deal\s*metadata.*owner/i,
    /metadata.*owner/i
  ];
  const pubIdPatterns = [/pub\s*id/i, /publisher\s*id/i, /publisher/i, /^pub$/i];
  const revenuePatterns = [
    /deal\s*spend/i,
    /revenue/i,
    /^rev$/i,
    /amount/i,
    /value/i,
    /budget/i,
    /income/i,
    /earnings/i
  ];

  const findMatch = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = headers.find(h => pattern.test(h.trim()));
      if (match) return match;
    }
    return '';
  };

  mappings.dealIdCol = findMatch(idPatterns) || headers[0] || '';
  mappings.dealNameCol = findMatch(namePatterns) || headers[1] || '';
  mappings.ownerCol = findMatch(ownerPatterns) || '';
  mappings.ownerMetaCol = findMatch(ownerMetaPatterns) || '';
  mappings.pubIdCol = findMatch(pubIdPatterns) || '';
  mappings.revenueCol = findMatch(revenuePatterns) || '';

  return mappings;
}

export interface MappedDeal {
  id: string;
  name: string;
  owner: string;
  ownerMeta: string;
  pubId: string;
  revenue: number;
}

/**
 * Maps raw rows into standardized deal objects using the mappings.
 * @param rows - The raw parsed rows.
 * @param mappings - Column mappings.
 * @returns Array of mapped deals.
 */
export function mapParsedData(rows: Record<string, unknown>[], mappings: ColumnMappings): MappedDeal[] {
  return rows.map((row, index) => {
    const rawId = row[mappings.dealIdCol];
    const id = rawId !== undefined && rawId !== null ? String(rawId).trim() : '';

    const rawName = row[mappings.dealNameCol];
    const name = rawName !== undefined && rawName !== null ? String(rawName).trim() : `Deal ${id || index + 1}`;

    const rawOwner = row[mappings.ownerCol];
    const rawOwnerMeta = mappings.ownerMetaCol ? row[mappings.ownerMetaCol] : '';
    const owner = rawOwner !== undefined && rawOwner !== null ? String(rawOwner).trim() : '';
    const ownerMeta = rawOwnerMeta !== undefined && rawOwnerMeta !== null ? String(rawOwnerMeta).trim() : '';

    const rawPubId = mappings.pubIdCol ? row[mappings.pubIdCol] : '';
    const pubId = rawPubId !== undefined && rawPubId !== null ? String(rawPubId).trim() : '';

    const rawRevenue = mappings.revenueCol ? row[mappings.revenueCol] : '';
    let revenue = 0;
    if (rawRevenue !== undefined && rawRevenue !== null) {
      const cleaned = String(rawRevenue).replace(/[^0-9.]/g, '');
      revenue = parseFloat(cleaned) || 0;
    }

    return { id, name, owner, ownerMeta, pubId, revenue };
  }).filter(deal => deal.id);
}

export interface ResolvedOwner {
  value: string;
  isMetadataFallback: boolean;
  isMissing: boolean;
}

/**
 * Resolves the effective owner for display/grouping, preferring primary owner.
 * @param deal - The deal object.
 * @returns Resolved owner info.
 */
export function resolveOwner(deal: { owner: string; ownerMeta: string }): ResolvedOwner {
  if (deal.owner) {
    return { value: deal.owner, isMetadataFallback: false, isMissing: false };
  }
  if (deal.ownerMeta) {
    return { value: deal.ownerMeta, isMetadataFallback: true, isMissing: false };
  }
  return { value: 'Unknown Owner', isMetadataFallback: false, isMissing: true };
}
