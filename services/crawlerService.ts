import { CrawlerResult, AppData } from '../types';
import { invoke } from '@tauri-apps/api/core';

function isTauri(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__TAURI__;
}

// Proxies to try in order to ensure reliability
const PROXY_STRATEGIES = [
    {
        name: 'corsproxy',
        getUrl: (target: string) => `https://corsproxy.io/?${encodeURIComponent(target)}`
    },
    {
        name: 'allorigins',
        getUrl: (target: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}&disableCache=true`
    },
    {
        name: 'codetabs',
        getUrl: (target: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`
    }
];

/**
 * Fetches text content from a URL using a rotating list of CORS proxies.
 */
export const fetchTextWithFallback = async (targetUrl: string): Promise<string> => {
    // If running inside Tauri, bypass CORS using native Rust fetch
    if (isTauri()) {
        try {
            const text = await invoke<string>('native_fetch', {
                url: targetUrl,
                method: 'GET',
                headers: {},
                body: null,
            });
            return text;
        } catch (e: any) {
            console.error(`Tauri native fetch failed for ${targetUrl}:`, e);
            throw new Error(`Failed to fetch content from ${targetUrl} via Tauri native client: ${e}`);
        }
    }

    const fetchWithTimeout = (url: string, timeoutMs: number) => {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);
        return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(id));
    };

    // 1. Try Direct Fetch First (Fastest, avoids proxy issues if server allows CORS)
    try {
        const directResponse = await fetchWithTimeout(targetUrl, 8000);
        if (directResponse.ok) {
            const text = await directResponse.text();
            if (text && text.length >= 10) return text;
        }
    } catch (e) {
        // console.log(`Direct fetch failed for ${targetUrl}`);
    }

    // 2. Try Custom Backend Proxy (Most Reliable) — short timeout so a dead server doesn't hang us
    // We assume the proxy is running on the SAME hostname we are currently on
    try {
        const hostname = window.location.hostname;
        const proxyPort = (import.meta as any).env?.VITE_PROXY_PORT || 3001;
        const proxyUrl = `http://${hostname}:${proxyPort}/proxy?url=${encodeURIComponent(targetUrl)}`;

        const response = await fetchWithTimeout(proxyUrl, 2000);
        if (response.ok) {
            const text = await response.text();
            if (text && text.length >= 10) return text;
        }
    } catch (e) {
        // console.warn('Custom proxy failed (is proxy running?)', e);
    }

    // 3. Fallback to Public Proxies (Parallel for speed)
    const proxyPromises = PROXY_STRATEGIES.map(strategy => 
        fetch(strategy.getUrl(targetUrl))
            .then(async response => {
                if (!response.ok) {
                    if (response.status === 403 || response.status === 429) {
                        console.warn(`Proxy ${strategy.name} blocked request (Status ${response.status})`);
                        throw new Error(`Blocked (${response.status})`);
                    }
                    throw new Error(`Status ${response.status}`);
                }
                const text = await response.text();
                if (!text || text.length < 10) {
                    throw new Error('Empty or too short response');
                }
                return text;
            })
    );

    try {
        const text = await Promise.any(proxyPromises);
        return text;
    } catch {
        // All proxies failed
    }

    throw new Error(`Failed to fetch content from ${targetUrl} after trying direct access and multiple proxies.`);
};

const fetchPage = async (url: string): Promise<Document> => {
    try {
        const html = await fetchTextWithFallback(url);
        const parser = new DOMParser();
        return parser.parseFromString(html, 'text/html');
    } catch (error) {
        console.error(`Error fetching page ${url}:`, error);
        throw error;
    }
};

/**
 * Validates app-ads.txt existence following IAB specs (Root Domain + Subdomain check).
 */
export const checkAdsTxt = async (websiteUrl: string): Promise<{ status: 'success' | 'failed', code?: number, url: string }> => {
    if (!websiteUrl) return { status: 'failed', code: 400, url: '' };

    let urlsToCheck: string[] = [];

    try {
        // Normalize URL
        let urlToParse = websiteUrl.trim();
        if (!urlToParse.match(/^https?:\/\//)) {
            urlToParse = `https://${urlToParse}`;
        }
        const urlObj = new URL(urlToParse);
        const hostname = urlObj.hostname; // e.g. ffcc.zuiqiangyingyu.cn or www.example.com

        // 1. Check strict hostname provided
        urlsToCheck.push(`https://${hostname}/app-ads.txt`);

        // 2. Check root domain (approximate eTLD+1) logic
        // Remove 'www.'
        const cleanHost = hostname.replace(/^www\./, '');
        if (cleanHost !== hostname) {
            urlsToCheck.push(`https://${cleanHost}/app-ads.txt`);
        }

        // If we have subdomains (e.g. sub.example.com), try to find parent domain (example.com)
        const parts = cleanHost.split('.');
        if (parts.length >= 3) {
            // Heuristic: take last two parts. 
            // Note: This fails for co.uk, but handles generic .com/.net correctly.
            // For a perfect solution, a Public Suffix List library is needed, but this covers 90% of cases.
            const rootDomain = parts.slice(-2).join('.');
            urlsToCheck.push(`https://${rootDomain}/app-ads.txt`);
            urlsToCheck.push(`https://www.${rootDomain}/app-ads.txt`);
        }

        // 3. Fallback http
        urlsToCheck.push(`http://${cleanHost}/app-ads.txt`);

        // Remove duplicates
        urlsToCheck = [...new Set(urlsToCheck)];

    } catch (e) {
        return { status: 'failed', code: 400, url: websiteUrl };
    }

    // Try each URL candidate
    for (const candidateUrl of urlsToCheck) {
        try {
            const content = await fetchTextWithFallback(candidateUrl);

            // Validation: Must not be HTML (common 404 pages or redirects to home)
            const lower = content.toLowerCase();
            if (lower.includes('<!doctype html') || lower.includes('<html') || lower.includes('<body')) {
                continue; // Looked like a webpage, not a text file
            }

            // Basic content check: usually contains "google.com" or "direct" or "reseller"
            // If content is extremely short or just whitespace, skip
            if (content.trim().length < 5) continue;

            return { status: 'success', url: candidateUrl };
        } catch (error) {
            // Continue to next candidate
        }
    }

    // If all failed, return the primary candidate as the failed URL
    return { status: 'failed', code: 404, url: urlsToCheck[0] };
};

export const revalidateApp = async (app: AppData): Promise<AppData> => {
    const adsResult = await checkAdsTxt(app.developerWebsite);
    return {
        ...app,
        adsTxtUrl: adsResult.url,
        adsTxtStatus: adsResult.status,
        adsTxtStatusCode: adsResult.code
    };
};

/**
 * "Smart Scraper" that scans document for links matching a pattern,
 * avoiding reliance on brittle CSS classes.
 */
const findLinkByPattern = (doc: Document, pattern: string | RegExp): HTMLAnchorElement | null => {
    const allLinks = Array.from(doc.querySelectorAll('a'));
    return allLinks.find(link => {
        const href = link.getAttribute('href');
        if (!href) return false;
        if (typeof pattern === 'string') {
            return href.includes(pattern);
        }
        return pattern.test(href);
    }) as HTMLAnchorElement | null;
};

// Batch processor to limit concurrency
async function processInBatches<T, R>(
    items: T[],
    batchSize: number,
    processor: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(processor));
        results.push(...batchResults);
    }
    return results;
}

const cleanDeveloperName = (rawName: string): string => {
    if (!rawName) return 'Unknown Developer';
    // Remove common prefixes like "Developer :", "Offered by :", "By "
    return rawName
        .replace(/^(Developer|Offered by|By)\s*[:|-]?\s*/i, '')
        .trim();
};

const normalizeInput = (input: string): string => {
    const trimmed = input.trim();

    // Check if it's already a URL
    if (trimmed.startsWith('http')) {
        return trimmed;
    }

    // Heuristics for Android Package ID (e.g. com.example.app)
    // usually contains dots, at least one dot, no spaces
    if (trimmed.includes('.') && !trimmed.includes(' ')) {
        return `https://play.google.com/store/apps/details?id=${trimmed}`;
    }

    // Heuristics for iOS ID (e.g. 123456789 or id123456789)
    // numeric or starts with id followed by numbers
    if (/^\d+$/.test(trimmed)) {
        return `https://apps.apple.com/app/id${trimmed}`;
    }
    if (/^id\d+$/.test(trimmed)) {
        return `https://apps.apple.com/app/${trimmed}`;
    }

    // Fallback: Assume it's a bundle ID if not sure
    return `https://play.google.com/store/apps/details?id=${trimmed}`;
};

const extractAppNameFromUrl = (url: string, isGooglePlay: boolean): string => {
    try {
        if (isGooglePlay) {
            const params = new URL(url).searchParams;
            const id = params.get('id');
            return id ? id : 'Unknown Android App';
        } else {
            // iOS: https://apps.apple.com/us/app/app-name/id123
            const parts = url.split('/');
            // usually the part before /idXXXX is the name
            const idIndex = parts.findIndex(p => p.startsWith('id'));
            if (idIndex > 0) {
                return parts[idIndex - 1].replace(/-/g, ' ');
            }
            return 'Unknown iOS App';
        }
    } catch (e) {
        return 'Unknown App';
    }
};

const normalizeAppUrl = (url: string, isGooglePlay: boolean): string => {
    try {
        const u = new URL(url);
        if (isGooglePlay) {
            const id = u.searchParams.get('id');
            return id ? `https://play.google.com/store/apps/details?id=${id}` : url;
        } else {
            // iOS clean up
            u.search = '';
            return u.toString();
        }
    } catch (e) {
        return url;
    }
};

export const analyzeUrl = async (rawInput: string): Promise<CrawlerResult> => {
    const inputUrl = normalizeInput(rawInput);
    const lowerUrl = inputUrl.toLowerCase();

    const isGooglePlay = lowerUrl.includes('play.google.com') || lowerUrl.includes('android');

    if (!isGooglePlay && !lowerUrl.includes('apps.apple.com') && !lowerUrl.includes('ios')) {
        throw new Error('Unsupported Input. Please provide a valid URL, Android Package Name (com.x.y), or iOS App ID.');
    }

    const inputDoc = await fetchPage(inputUrl);
    let developerUrl = '';
    let developerName = '';
    let developerAddress = '';

    // --- Step 1: Identify Developer ---

    if (isGooglePlay) {
        if (lowerUrl.includes('developer?id=') || lowerUrl.includes('/dev?id=')) {
            developerUrl = inputUrl;
            const h1 = inputDoc.querySelector('h1');
            developerName = h1?.textContent || '';
        } else {
            const devLink = findLinkByPattern(inputDoc, /\/store\/apps\/(developer|dev)\?id=/);
            if (devLink) {
                let href = devLink.getAttribute('href') || '';
                if (!href.startsWith('http')) href = `https://play.google.com${href}`;
                developerUrl = href;
                developerName = devLink.textContent || '';
            } else {
                // Fallback: try to find generic "More by..." header or link
                const moreByLinks = Array.from(inputDoc.querySelectorAll('a')).filter(a =>
                    a.href.includes('/store/apps/dev') || a.href.includes('/store/apps/developer')
                );
                if (moreByLinks.length > 0) {
                    let href = moreByLinks[0].getAttribute('href') || '';
                    if (!href.startsWith('http')) href = `https://play.google.com${href}`;
                    developerUrl = href;
                    developerName = moreByLinks[0].textContent || 'Unknown Developer';
                } else {
                    throw new Error('Could not identify Developer Page. Google Play layout may have changed.');
                }
            }

            // Address Extraction: Look for "Developer contact" or "App support"
            const allElements = Array.from(inputDoc.querySelectorAll('*'));
            const devContactHeader = allElements.find(el => {
                const t = el.textContent?.trim().toLowerCase();
                return t === 'developer contact' || t === 'app support';
            });

            if (devContactHeader) {
                const container = devContactHeader.parentElement?.parentElement;
                if (container) {
                    const addressDivs = Array.from(container.querySelectorAll('div'));
                    const addressLine = addressDivs.find(div => {
                        const txt = div.textContent || '';
                        // Basic address heuristic
                        return txt.length > 15 && !txt.includes('@') && !txt.startsWith('http') && !txt.includes('Privacy policy');
                    });
                    if (addressLine) {
                        developerAddress = addressLine.textContent?.trim() || '';
                    }
                }
            }
        }
    } else {
        // iOS Logic
        if (lowerUrl.includes('/developer/')) {
            developerUrl = inputUrl;
            const h1 = inputDoc.querySelector('h1');
            developerName = h1?.textContent?.trim() || '';
        } else {
            const devLink = findLinkByPattern(inputDoc, /\/developer\//);
            if (devLink) {
                const href = devLink.getAttribute('href');
                developerUrl = href || '';
                developerName = devLink.textContent?.trim() || '';
            } else {
                const subtitleLink = inputDoc.querySelector('h2.product-header__identity a') || inputDoc.querySelector('.app-header__identity a');
                if (subtitleLink) {
                    developerUrl = subtitleLink.getAttribute('href') || '';
                    developerName = subtitleLink.textContent?.trim() || '';
                } else {
                    throw new Error('Could not identify Developer Page from this App Store link.');
                }
            }
        }
    }

    developerName = cleanDeveloperName(developerName);

    // --- Step 2: Fetch Developer Page ---
    const devPageDoc = await fetchPage(developerUrl);
    const uniqueAppUrls = new Set<string>();

    // --- Step 3: Extract Apps from Developer Page & Sub-pages ---

    const extractAppsFromDoc = (doc: Document, docUrl: string) => {
        const links = Array.from(doc.querySelectorAll('a'));
        links.forEach(link => {
            const href = link.getAttribute('href');
            if (!href) return;

            let fullUrl = '';
            try {
                fullUrl = href.startsWith('http') ? href : new URL(href, docUrl).toString();
            } catch (e) { return; }

            if (isGooglePlay) {
                if (fullUrl.includes('/store/apps/details?id=')) {
                    uniqueAppUrls.add(normalizeAppUrl(fullUrl, true));
                }
            } else {
                if (fullUrl.includes('/app/') && !fullUrl.includes('see-all')) {
                    uniqueAppUrls.add(normalizeAppUrl(fullUrl, false));
                }
            }
        });
    };

    // 3a. Extract from main page
    extractAppsFromDoc(devPageDoc, developerUrl);

    // 3b. Look for "See All" / Pagination links and crawl them
    const paginationUrls = new Set<string>();
    const allPageLinks = Array.from(devPageDoc.querySelectorAll('a'));

    allPageLinks.forEach(link => {
        const href = link.getAttribute('href');
        const text = link.textContent?.toLowerCase() || '';
        if (!href) return;

        let fullUrl = '';
        try {
            fullUrl = href.startsWith('http') ? href : new URL(href, developerUrl).toString();
        } catch (e) { return; }

        if (isGooglePlay) {
            // "See more" links often point to collections or cluster pages
            if ((text.includes('see more') || text.includes('see all') || link.className.includes('onMcl')) &&
                (fullUrl.includes('/collection/') || fullUrl.includes('/developer?id='))) {
                paginationUrls.add(fullUrl);
            }
        } else {
            // iOS "See All" links often in headers of sections
            if (text.includes('see all') || href.includes('see-all')) {
                paginationUrls.add(fullUrl);
            }
        }
    });

    // Limit recursion to top 5 sub-pages to prevent timeouts
    const subPagesToCrawl = Array.from(paginationUrls).slice(0, 5);

    if (subPagesToCrawl.length > 0) {
        console.log(`Found ${subPagesToCrawl.length} sub-pages to crawl for apps...`);
        await Promise.all(subPagesToCrawl.map(async (subUrl) => {
            try {
                const subDoc = await fetchPage(subUrl);
                extractAppsFromDoc(subDoc, subUrl);
            } catch (e) {
                console.warn(`Failed to crawl sub-page ${subUrl}`);
            }
        }));
    }

    // Fallback for Google Play: if very few apps were found on the dev page,
    // the store may be using lazy-loading. Try a pub: search to expand the list.
    if (isGooglePlay && uniqueAppUrls.size <= 12 && developerName) {
        try {
            const searchUrl = `https://play.google.com/store/search?q=pub:${encodeURIComponent(developerName)}&c=apps`;
            const searchDoc = await fetchPage(searchUrl);
            extractAppsFromDoc(searchDoc, searchUrl);
            console.log(`Expanded app list via pub: search to ${uniqueAppUrls.size} apps.`);
        } catch (e) {
            console.warn('Pub search fallback failed:', e);
        }
    }

    const appUrlsToProcess = Array.from(uniqueAppUrls);
    console.log(`Total apps found: ${appUrlsToProcess.length}`);

    // --- Step 4: Process Apps in Batches ---
    // Cache ads.txt results per developer website to avoid redundant checks
    const adsTxtCache = new Map<string, Promise<{ status: 'success' | 'failed', code?: number, url: string }>>();
    const getCachedAdsTxt = (websiteUrl: string) => {
        if (!websiteUrl) return Promise.resolve({ status: 'failed' as const, code: 400, url: '' });
        if (adsTxtCache.has(websiteUrl)) return adsTxtCache.get(websiteUrl)!;
        const promise = checkAdsTxt(websiteUrl);
        adsTxtCache.set(websiteUrl, promise);
        return promise;
    };

    // Increased concurrency for faster processing
    const processedApps = await processInBatches(appUrlsToProcess, 20, async (storeUrl) => {
        try {
            const appDoc = await fetchPage(storeUrl);

            let appName = '';
            let developerWebsite = '';

            if (isGooglePlay) {
                appName = appDoc.querySelector('h1')?.textContent || 'Unknown App';

                // Strategy 1: Check Meta Tag "appstore:developer_url" (High Priority)
                const metaDevUrl = appDoc.querySelector('meta[name="appstore:developer_url"]')?.getAttribute('content');
                if (metaDevUrl && metaDevUrl.startsWith('http')) {
                    developerWebsite = metaDevUrl;
                }

                // Strategy 2: Refined Website Extraction Logic using Text Search (Fallback)
                if (!developerWebsite) {
                    const allElements = Array.from(appDoc.querySelectorAll('*'));
                    // Look for both common headers: 'Developer contact' and 'App support'
                    const contactHeader = allElements.find(el => {
                        const t = el.textContent?.trim().toLowerCase();
                        return t === 'developer contact' || t === 'app support';
                    });

                    let possibleLinks: HTMLAnchorElement[] = [];

                    if (contactHeader) {
                        // If we found the header, look in its container hierarchy (up 2 levels usually covers the expander group)
                        const container = contactHeader.parentElement?.parentElement;
                        if (container) {
                            possibleLinks = Array.from(container.querySelectorAll('a'));
                        }
                    }

                    // Fallback: If heuristic failed, look at all links
                    if (possibleLinks.length === 0) {
                        possibleLinks = Array.from(appDoc.querySelectorAll('a'));
                    }

                    const websiteAnchor = possibleLinks.find(a => {
                        const href = a.getAttribute('href');
                        if (!href) return false;

                        // Handle Google Redirects
                        const realUrl = href.includes('google.com/url?q=')
                            ? (new URL(href).searchParams.get('q') || href)
                            : href;

                        if (!realUrl.startsWith('http')) return false;

                        // Exclusion List
                        if (realUrl.includes('play.google.com')) return false;
                        if (realUrl.includes('support.google.com')) return false;
                        if (realUrl.includes('policies.google.com')) return false;
                        if (realUrl.includes('mailto:')) return false;

                        const text = a.textContent?.toLowerCase() || '';
                        const label = a.getAttribute('aria-label')?.toLowerCase() || '';

                        // Strict Inclusion: Must contain "website" if we are in the fallback "all links" mode
                        // But if we are inside the contact container, we can be a bit more flexible (though text usually says Website)
                        if (text.includes('website') || label.includes('website')) return true;

                        // If found inside the specific contact container, and it's not privacy policy, prioritize it.
                        if (contactHeader && contactHeader.parentElement?.parentElement?.contains(a) && !text.includes('privacy')) {
                            return true;
                        }

                        return false;
                    });

                    if (websiteAnchor) {
                        let href = websiteAnchor.getAttribute('href') || '';
                        if (href.includes('google.com/url?q=')) {
                            href = new URL(href).searchParams.get('q') || href;
                        }
                        developerWebsite = href;
                    }
                }
            } else {
                // iOS Logic
                const h1 = appDoc.querySelector('h1');
                appName = h1?.textContent?.split('\n')[0].trim() || 'Unknown App';

                const allAnchors = Array.from(appDoc.querySelectorAll('a'));
                const websiteAnchor = allAnchors.find(a => {
                    const t = a.textContent?.toLowerCase() || '';
                    // Broader matching for iOS labels
                    return t.includes('developer website') || t.includes('app support') || t.includes('website');
                });

                if (websiteAnchor) {
                    developerWebsite = websiteAnchor.getAttribute('href') || '';
                }
            }

            const adsResult = await getCachedAdsTxt(developerWebsite);

            return {
                appName,
                storeUrl,
                developerWebsite,
                adsTxtUrl: adsResult.url,
                adsTxtStatus: adsResult.status,
                adsTxtStatusCode: adsResult.code
            } as AppData;

        } catch (e) {
            console.warn(`Failed to process app ${storeUrl}, using fallback data.`, e);
            const fallbackName = extractAppNameFromUrl(storeUrl, isGooglePlay);
            return {
                appName: fallbackName,
                storeUrl: storeUrl,
                developerWebsite: '',
                adsTxtUrl: '',
                adsTxtStatus: 'failed',
                adsTxtStatusCode: 0
            } as AppData;
        }
    });

    return {
        developer: {
            name: developerName,
            url: developerUrl,
            platform: isGooglePlay ? 'Android' : 'iOS',
            totalApps: processedApps.length,
            address: developerAddress
        },
        apps: processedApps
    };
};