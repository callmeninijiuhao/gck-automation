import { fetchTextWithFallback } from './crawlerService';

export interface SellerData {
    seller_id: string;
    seller_type: string;
    name: string;
    domain: string;
    is_confidential?: number;
    is_passthrough?: number;
}

export interface SellerResult {
    sellerId: string;
    sellerType: string;
    name: string;
    domain: string;
}

// Helper to guess domain from input
const guessDomains = (input: string): string[] => {
    let domain = input.trim().toLowerCase();

    // Remove protocol and paths
    domain = domain.replace(/^https?:\/\//, '');
    if (!domain.includes('sellers.json')) {
        domain = domain.split('/')[0];
    }

    const candidates: string[] = [];

    // 1. If input is a full URL to sellers.json, trust it first
    if (input.includes('sellers.json')) {
        candidates.push(input);
        return candidates;
    }

    // 2. If input looks like a domain (has a dot), try it directly
    if (domain.includes('.')) {
        candidates.push(`https://${domain}/sellers.json`);
        // Also try without www if it has it
        if (domain.startsWith('www.')) {
            candidates.push(`https://${domain.replace('www.', '')}/sellers.json`);
        }
    } else {
        // 3. If input is a single word (e.g. "magnite"), try common varieties
        candidates.push(`https://${domain}.com/sellers.json`); // magnite.com
        candidates.push(`https://www.${domain}.com/sellers.json`); // www.magnite.com
        candidates.push(`https://${domain}.io/sellers.json`); // generic.io
    }

    return candidates;
};

export const fetchSellersJson = async (domainOrUrl: string): Promise<SellerData[]> => {
    const candidates = guessDomains(domainOrUrl);
    let lastError: Error | null = null;

    console.log(`Trying candidates for ${domainOrUrl}:`, candidates);

    for (const targetUrl of candidates) {
        try {
            console.log(`Fetching sellers.json from: ${targetUrl}`);
            const content = await fetchTextWithFallback(targetUrl);

            try {
                const json = JSON.parse(content);
                const sellers = Array.isArray(json) ? json : (json.sellers || []);

                if (!Array.isArray(sellers)) {
                    // If parsed but invalid, maybe try next candidate? 
                    // Usually invalid structure means we found A file but not THE file.
                    throw new Error('Invalid sellers.json format: "sellers" array not found.');
                }

                return sellers as SellerData[];
            } catch (e) {
                // Parse error implies bad content
                throw new Error('Failed to parse content as JSON.');
            }
        } catch (error: any) {
            console.warn(`Failed to fetch from ${targetUrl}: ${error.message}`);
            lastError = error;
            // Continue to next candidate
        }
    }

    throw new Error(`Failed to fetch sellers.json. Tried: ${candidates.join(', ')}. Last error: ${lastError?.message}`);
};

export const searchBSellers = (sellers: SellerData[], entityName: string): SellerResult[] => {
    if (!entityName) return [];

    const query = entityName.toLowerCase();

    return sellers
        .filter(seller =>
            (seller.name && seller.name.toLowerCase().includes(query)) ||
            (seller.domain && seller.domain.toLowerCase().includes(query))
        )
        .map(seller => ({
            sellerId: seller.seller_id,
            sellerType: seller.seller_type,
            name: seller.name,
            domain: seller.domain
        }));
};
