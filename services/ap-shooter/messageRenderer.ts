import { resolveOwner } from './csvParser';

/**
 * Extracts a friendly name from an owner string (typically an email).
 * @param owner - The owner string.
 * @returns The formatted name.
 */
export function getOwnerName(owner: string): string {
  if (!owner) return 'Deal Owner';

  let namePart = owner;
  if (owner.includes('@')) {
    namePart = owner.split('@')[0];
  }

  namePart = namePart.replace(/[._-]/g, ' ');
  return namePart
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export interface GroupedDeal {
  dealId: string;
  dealName: string;
  publishers: string[];
}

export interface GroupedGap {
  owner: string;
  ownerName: string;
  deals: GroupedDeal[];
}

export interface GapDataItem {
  pubId: string;
  missingDeals: Array<{ id: string; name: string; owner: string; ownerMeta?: string }>;
  failed: boolean;
}

/**
 * Groups gap data by owner to create consolidated email messages.
 * @param gapData - The gap calculation results.
 * @returns Grouped gaps by owner.
 */
export function groupGapsByOwner(gapData: GapDataItem[]): GroupedGap[] {
  const groups: Record<string, { owner: string; ownerName: string; dealsMap: Record<string, GroupedDeal> }> = {};

  gapData.forEach(gapRecord => {
    if (gapRecord.failed) return;

    gapRecord.missingDeals.forEach(deal => {
      const resolved = resolveOwner({ owner: deal.owner, ownerMeta: (deal as Record<string, string>).ownerMeta || '' });
      const rawOwners = deal.owner
        ? String(deal.owner).split(',')
        : [resolved.value];

      rawOwners.forEach(rawOwner => {
        const owner = rawOwner.trim();
        if (!owner || owner === 'Unknown Owner') return;

        const ownerKey = owner.toLowerCase();

        if (!groups[ownerKey]) {
          groups[ownerKey] = {
            owner,
            ownerName: getOwnerName(owner),
            dealsMap: {}
          };
        }

        const dealKey = deal.id.toLowerCase();
        if (!groups[ownerKey].dealsMap[dealKey]) {
          groups[ownerKey].dealsMap[dealKey] = {
            dealId: deal.id,
            dealName: deal.name,
            publishers: []
          };
        }

        if (!groups[ownerKey].dealsMap[dealKey].publishers.includes(gapRecord.pubId)) {
          groups[ownerKey].dealsMap[dealKey].publishers.push(gapRecord.pubId);
        }
      });
    });
  });

  return Object.values(groups)
    .map(group => {
      const deals = Object.values(group.dealsMap).sort((a, b) =>
        a.dealId.localeCompare(b.dealId)
      );

      return {
        owner: group.owner,
        ownerName: group.ownerName,
        deals
      };
    })
    .sort((a, b) => a.owner.localeCompare(b.owner));
}

/**
 * Renders a consolidated message using the template and values.
 * @param template - The template string.
 * @param values - The replacement values.
 * @returns The rendered template text.
 */
export function renderMessage(template: string, values: { ownerName: string; deals: GroupedDeal[] }): string {
  const dealListText = values.deals
    .map(deal => {
      const pubList = deal.publishers.map(pub => `• ${pub}`).join('\n');
      return `Deal ID: ${deal.dealId}\nDeal Name: "${deal.dealName}"\nPublisher ID(s):\n${pubList}`;
    })
    .join('\n\n');

  const dealCount = values.deals.length;
  const publisherCount = values.deals.reduce((acc, d) => acc + d.publishers.length, 0);

  return template
    .replace(/{owner_name}/g, values.ownerName)
    .replace(/{deal_list}/g, dealListText)
    .replace(/{deal_count}/g, String(dealCount))
    .replace(/{publisher_count}/g, String(publisherCount));
}
