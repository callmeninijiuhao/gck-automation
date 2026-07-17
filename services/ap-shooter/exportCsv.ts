function escapeCSVField(field: unknown): string {
  if (field === null || field === undefined) {
    return '';
  }
  const str = String(field);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export interface GapDataItem {
  pubId: string;
  missingDeals: Array<{ id: string; name: string; owner: string; revenue?: number }>;
  failed: boolean;
  errorMsg?: string;
}

/**
 * Generates and downloads a CSV file containing the gap analysis details.
 * @param gapData - The computed gap data.
 */
export function exportGapsToCsv(gapData: GapDataItem[]): void {
  const headers = ['Publisher ID', 'Deal ID', 'Deal Name', 'Deal Owner', 'Deal Revenue'];
  const rows: (string | number)[][] = [];

  gapData.forEach(pubRecord => {
    if (pubRecord.failed) {
      rows.push([
        pubRecord.pubId,
        'ERROR',
        pubRecord.errorMsg ? String(pubRecord.errorMsg).replace(/^✗ Failed:\s*/, '') : 'Failed to fetch live deals',
        '—',
        '—'
      ]);
      return;
    }

    if (pubRecord.missingDeals.length === 0) {
      return;
    }

    pubRecord.missingDeals.forEach(deal => {
      rows.push([
        pubRecord.pubId,
        deal.id,
        deal.name,
        deal.owner,
        deal.revenue !== undefined ? deal.revenue : 0
      ]);
    });
  });

  const csvContent = [
    headers.map(escapeCSVField).join(','),
    ...rows.map(row => row.map(escapeCSVField).join(','))
  ].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.setAttribute('href', url);

  const dateStr = new Date().toISOString().split('T')[0];
  link.setAttribute('download', `ap_gap_report_${dateStr}.csv`);

  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Generates and downloads an Excel (.xlsx) file containing the gap analysis details.
 * @param gapData - The computed gap data.
 */
export function exportGapsToExcel(gapData: GapDataItem[]): void {
  import('xlsx').then(XLSX => {
    const headers = ['Publisher ID', 'Deal ID', 'Deal Name', 'Deal Owner', 'Deal Revenue'];
    const rows: (string | number)[][] = [];

    gapData.forEach(pubRecord => {
      if (pubRecord.failed) {
        rows.push([
          pubRecord.pubId,
          'ERROR',
          pubRecord.errorMsg ? String(pubRecord.errorMsg).replace(/^✗ Failed:\s*/, '') : 'Failed to fetch live deals',
          '—',
          '—'
        ]);
        return;
      }

      if (pubRecord.missingDeals.length === 0) {
        return;
      }

      pubRecord.missingDeals.forEach(deal => {
        rows.push([
          pubRecord.pubId,
          deal.id,
          deal.name,
          deal.owner,
          deal.revenue !== undefined ? deal.revenue : 0
        ]);
      });
    });

    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Gap Analysis');

    const dateStr = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `ap_gap_report_${dateStr}.xlsx`);
  });
}
