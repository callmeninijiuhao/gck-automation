export interface WantedDeal {
  id: string;
  name: string;
  owner: string;
  revenue?: number;
}

export interface FetchStatusInfo {
  status: string;
  errorMsg?: string;
}

export interface GapRecord {
  pubId: string;
  coverage: number;
  missingDeals: WantedDeal[];
  monetizingCount: number;
  wantedCount: number;
  failed: boolean;
  errorMsg?: string;
  missingRevenue: number;
}

export interface GapResult {
  stats: {
    totalPublishers: number;
    publishersWithGaps: number;
    totalGaps: number;
    totalMissingRevenue: number;
  };
  gapData: GapRecord[];
}

/**
 * Computes coverage and identifies missing deals for each publisher.
 * @param wantedDeals - List of wanted deals.
 * @param monetizingMap - Map of publisher ID to their monetizing deal IDs.
 * @param fetchStatusMap - Optional map of publisher ID to their fetch status.
 * @returns Gap analysis result.
 */
export function calculateGaps(
  wantedDeals: WantedDeal[],
  monetizingMap: Record<string, string[]>,
  fetchStatusMap: Record<string, FetchStatusInfo> = {}
): GapResult {
  const gapData: GapRecord[] = [];
  let publishersWithGaps = 0;
  let totalGaps = 0;
  let totalMissingRevenue = 0;

  const publishers = Object.keys(monetizingMap);

  publishers.forEach(pubId => {
    const statusInfo = fetchStatusMap[pubId];
    const isFailed = statusInfo?.status === 'error';

    if (isFailed) {
      gapData.push({
        pubId,
        coverage: 0,
        missingDeals: [],
        monetizingCount: 0,
        wantedCount: wantedDeals.length,
        failed: true,
        errorMsg: statusInfo?.errorMsg || 'Fetch failed',
        missingRevenue: 0
      });
      return;
    }

    const monetizingDeals = monetizingMap[pubId] || [];
    const monetizingSet = new Set(monetizingDeals.map(id => String(id).toLowerCase().trim()));

    const missingDeals = wantedDeals.filter(deal => {
      const dealIdNormalized = String(deal.id).toLowerCase().trim();
      return !monetizingSet.has(dealIdNormalized);
    });

    const totalWanted = wantedDeals.length;
    const missingCount = missingDeals.length;
    const matchedCount = totalWanted - missingCount;

    const coverage = totalWanted > 0
      ? Math.round((matchedCount / totalWanted) * 100)
      : 100;

    const missingRevenue = missingDeals.reduce((sum, d) => sum + (d.revenue || 0), 0);

    if (missingCount > 0) {
      publishersWithGaps++;
      totalGaps += missingCount;
      totalMissingRevenue += missingRevenue;
    }

    gapData.push({
      pubId,
      coverage,
      missingDeals,
      monetizingCount: matchedCount,
      wantedCount: totalWanted,
      failed: false,
      missingRevenue
    });
  });

  gapData.sort((a, b) => {
    if (a.failed && !b.failed) return 1;
    if (!a.failed && b.failed) return -1;
    if (a.failed && b.failed) return a.pubId.localeCompare(b.pubId);

    const aMissing = a.missingDeals.length;
    const bMissing = b.missingDeals.length;
    if (bMissing !== aMissing) {
      return bMissing - aMissing;
    }
    return a.pubId.localeCompare(b.pubId);
  });

  return {
    stats: {
      totalPublishers: publishers.length,
      publishersWithGaps,
      totalGaps,
      totalMissingRevenue
    },
    gapData
  };
}
