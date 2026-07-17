import React, { useState, useEffect } from 'react';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { StatusBadge } from '../components/StatusBadge';
import { CrawlerResult, LoadingState } from '../types';
import { analyzeUrl } from '../services/crawlerService';
import { 
  Search, 
  Globe, 
  Smartphone, 
  ExternalLink,
  Info,
  Layers,
  AlertTriangle,
  MapPin,
  Mail,
  Copy,
  Check,
  Settings,
  RefreshCw,
  Target,
  ListOrdered,
  ShieldCheck
} from 'lucide-react';

interface EmailVariables {
  sdkName: string;
  mediationPartner: string;
  developerAccountUrl: string;
  adsTxtUrlString: string;
  bundleList: string;
}

export const PubOnboardingValidator: React.FC = () => {
  const [inputValue, setInputValue] = useState('');
  const [loadingState, setLoadingState] = useState<LoadingState>('idle');
  const [result, setResult] = useState<CrawlerResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Email Generator State
  const [emailDraft, setEmailDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const [variables, setVariables] = useState<EmailVariables>({
    sdkName: 'OpenWrap SDK',
    mediationPartner: 'MAX mediation',
    developerAccountUrl: '',
    adsTxtUrlString: '',
    bundleList: ''
  });

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    setLoadingState('analyzing_input');
    setErrorMsg(null);
    setResult(null);

    try {
      setLoadingState('crawling_dev_page'); 
      const data = await analyzeUrl(inputValue);
      setResult(data);
      setLoadingState('complete');

    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "Failed to crawl the provided URL. Please verify the link and try again.");
      setLoadingState('error');
    }
  };

  // Effect: Populate variables when new result arrives
  useEffect(() => {
    if (result) {
      const isAndroid = result.developer.platform === 'Android';
      
      // Extract Unique Ads.txt URLs
      const adsTxtUrls = Array.from(new Set(
        result.apps
          .map(app => app.adsTxtUrl)
          .filter(url => url && url.length > 0)
      ));
      
      const adsTxtUrlString = adsTxtUrls.length > 0 
        ? adsTxtUrls.join(' and ') + ' - identical app-ads.txt files'
        : 'Not found';
    
      // Extract Bundles/IDs
      const bundleIds = result.apps.map(app => {
        if (!app.storeUrl) return 'Unknown ID';
        if (isAndroid) {
          try {
            const urlObj = new URL(app.storeUrl);
            return urlObj.searchParams.get('id') || app.storeUrl;
          } catch { return app.storeUrl; }
        } else {
          // iOS: .../id123456
          const match = app.storeUrl.match(/id(\d+)/);
          return match ? match[1] : app.storeUrl;
        }
      });

      setVariables(prev => ({
        ...prev,
        developerAccountUrl: result.developer.url,
        adsTxtUrlString,
        bundleList: bundleIds.join('\n')
      }));
    }
  }, [result]);

  // Effect: Regenerate draft when variables change
  useEffect(() => {
    if (result) {
      const isAndroid = result.developer.platform === 'Android';
      const devLabel = isAndroid ? 'Play Store Developer Account' : 'iOS App Store';
      
      const template = `Hey Avijit and Brian,

How are you doing? Seeking your review of a publisher opportunity please on mobile games, looking at integrating of ${variables.sdkName}. Below are the details:

${devLabel}: ${variables.developerAccountUrl}
App-ads.txt URL: ${variables.adsTxtUrlString}

Bundles to be reviewed:
${variables.bundleList}

You may find they have more titles in the developer profiles however only requesting to review the above due to they want to work with PubMatic for what ${variables.sdkName} has been certified as a mediation bidder, in this case ${variables.mediationPartner}. The other titles in app store are using Levelplay and PubMatic may need to upsell when OWSDK is certified by Unity. Also, I found per title per platform, the app-ads.txt URL may defer however the content has been always identical.

Could you kindly advise based on above?

Many thanks`;
      setEmailDraft(template);
    }
  }, [variables, result]);

  const handleCopyEmail = () => {
    navigator.clipboard.writeText(emailDraft);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleVariableChange = (key: keyof EmailVariables, value: string) => {
    setVariables(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div className="space-y-8">
      {/* Header Section */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold text-pubmatic-navy tracking-tight">Onboarding Validator</h1>
          <p className="text-gray-500 mt-2">Validate publisher apps for ads.txt compliance and metadata integrity.</p>
        </div>
        <div className="flex items-center space-x-2 text-sm text-gray-400 bg-white px-3 py-1.5 rounded-full border border-gray-200 shadow-sm">
            <Info size={14} />
            <span>Supported: Store URL, Bundle ID (Android), App ID (iOS)</span>
        </div>
      </div>

      {/* Info Card */}
      <div className="bg-white rounded-xl shadow-card border border-pubmatic-border overflow-hidden">
        <div className="p-1 bg-gradient-to-r from-pubmatic-blue via-pubmatic-teal to-pubmatic-blue opacity-80 h-1"></div>
        <div className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h3 className="text-sm font-bold text-pubmatic-navy mb-3 flex items-center gap-2">
                <Target size={16} className="text-pubmatic-teal" />
                Purpose
              </h3>
              <p className="text-sm text-gray-600 leading-relaxed">
                Automate the validation of mobile applications during the publisher onboarding process. This tool crawls Google Play and the Apple App Store to identify the developer, discover all apps under their portfolio, extract developer websites, and validate <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">app-ads.txt</code> compliance against IAB standards. It ensures every app has proper supply path transparency before integration.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-bold text-pubmatic-navy mb-3 flex items-center gap-2">
                <ListOrdered size={16} className="text-pubmatic-teal" />
                How to Use
              </h3>
              <ol className="text-sm text-gray-600 leading-relaxed space-y-2 list-decimal list-inside">
                <li><strong>Enter Input</strong> — Paste a Store URL, Android Bundle ID, or iOS App ID into the search field.</li>
                <li><strong>Analyze</strong> — Click <em>Analyze</em> to crawl the developer profile and discover all associated apps.</li>
                <li><strong>Review Results</strong> — Inspect each app's metadata, developer website, and computed <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">app-ads.txt</code> URL.</li>
                <li><strong>Check Compliance</strong> — Verify ads.txt status (Success / Failed) and review developer address if available.</li>
                <li><strong>Generate IQ Outreach</strong> — Use the email generator to draft onboarding communication with auto-populated app details.</li>
              </ol>
            </div>
          </div>
        </div>
      </div>

      {/* Input Card */}
      <div className="bg-white rounded-xl shadow-card border border-pubmatic-border overflow-hidden">
        <div className="p-1 bg-gradient-to-r from-pubmatic-blue via-pubmatic-teal to-pubmatic-blue opacity-80 h-1"></div>
        <div className="p-8">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_300px] gap-6">
            {/* Left: Input Form */}
            <div className="space-y-4">
              <form onSubmit={handleAnalyze} className="flex flex-col md:flex-row gap-4 items-end">
                <div className="flex-grow w-full">
                  <Input
                    label="Store URL or Bundle ID"
                    placeholder="e.g. com.example.app OR id123456789 OR https://play.google.com/..."
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    autoFocus
                    icon={<Search size={18} />}
                  />
                </div>
                <div className="w-full md:w-auto">
                   <Button 
                    type="submit" 
                    isLoading={loadingState !== 'idle' && loadingState !== 'complete' && loadingState !== 'error'}
                    icon={<Search size={18} />}
                    className="w-full md:w-auto"
                   >
                     Analyze
                   </Button>
                </div>
              </form>
              <p className="text-xs font-bold text-amber-700 flex items-center bg-amber-50 border border-amber-100 px-3 py-1.5 rounded-md w-fit">
                <Info size={12} className="mr-1.5 shrink-0 text-amber-600" />
                Scraping may take a moment — please be patient.
              </p>

              {/* Progress Indicator */}
              {(loadingState === 'analyzing_input' || loadingState === 'crawling_dev_page' || loadingState === 'validating_ads_txt') && (
                <div className="space-y-2">
                  <div className="flex justify-between text-xs font-semibold text-pubmatic-navy uppercase tracking-wide">
                    <span>Gathering Live Data...</span>
                    <span className="animate-pulse">Processing</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                    <div className="bg-pubmatic-blue h-2 rounded-full w-2/3 animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-pubmatic-blue via-pubmatic-teal to-pubmatic-blue bg-[length:200%_100%]"></div>
                  </div>
                  <p className="text-xs text-gray-500 text-center mt-2">
                    Scanning developer profile, extracting address, and validating ads.txt for all apps...
                  </p>
                </div>
              )}

              {errorMsg && (
                 <div className="p-4 bg-red-50 border border-red-100 rounded-lg text-red-700 text-sm flex items-center">
                    <div className="mr-3 bg-red-100 p-2 rounded-full"><AlertTriangle size={16} /></div>
                    {errorMsg}
                 </div>
              )}
            </div>

            {/* Right: Supported Formats */}
            <div className="bg-gray-50 rounded-lg border border-gray-100 p-5 space-y-4">
              <h4 className="text-sm font-bold text-pubmatic-navy flex items-center gap-2">
                <Smartphone size={14} className="text-pubmatic-teal" />
                Supported Formats
              </h4>
              <ul className="space-y-2 text-sm text-gray-600">
                <li className="flex items-start gap-2">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-pubmatic-teal shrink-0"></span>
                  <span><strong>Google Play URL</strong> — full store link</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-pubmatic-teal shrink-0"></span>
                  <span><strong>Bundle ID</strong> — e.g. <code className="bg-white px-1 py-0.5 rounded text-xs border border-gray-200">com.example.app</code></span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-pubmatic-teal shrink-0"></span>
                  <span><strong>iOS App ID</strong> — numeric or <code className="bg-white px-1 py-0.5 rounded text-xs border border-gray-200">id123456789</code></span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-pubmatic-teal shrink-0"></span>
                  <span><strong>App Store URL</strong> — full iTunes link</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Results Section */}
      {result && loadingState === 'complete' && (
        <div className="space-y-6 animate-fade-in-up">
          
          {/* Developer Info Card */}
          <div className="bg-white rounded-xl shadow-card border border-pubmatic-border p-6">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                <div className="flex items-center gap-4">
                    <div className="w-16 h-16 bg-pubmatic-lightBlue rounded-full flex items-center justify-center text-pubmatic-blue border border-blue-100 shrink-0">
                        <Globe size={32} />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-pubmatic-navy">{result.developer.name}</h2>
                        <a 
                            href={result.developer.url} 
                            target="_blank" 
                            rel="noreferrer"
                            className="text-pubmatic-blue hover:text-pubmatic-navy text-sm flex items-center mt-1 transition-colors"
                        >
                            View Developer Page <ExternalLink size={12} className="ml-1" />
                        </a>
                        {result.developer.address && (
                            <div className="flex items-start mt-2 text-xs text-gray-500 max-w-lg">
                                <MapPin size={12} className="mr-1 mt-0.5 shrink-0" />
                                <span>{result.developer.address}</span>
                            </div>
                        )}
                    </div>
                </div>
                <div className="flex gap-8 w-full md:w-auto border-t md:border-t-0 border-gray-100 pt-4 md:pt-0">
                    <div className="text-center px-6 py-2 border-r border-gray-100 last:border-0 flex-1 md:flex-none">
                        <p className="text-xs text-gray-400 uppercase tracking-widest font-semibold mb-1">Platform</p>
                        <div className="flex items-center justify-center text-pubmatic-navy font-bold">
                            <Smartphone size={16} className="mr-2 text-pubmatic-teal" />
                            {result.developer.platform}
                        </div>
                    </div>
                    <div className="text-center px-6 py-2 flex-1 md:flex-none">
                        <p className="text-xs text-gray-400 uppercase tracking-widest font-semibold mb-1">Total Apps</p>
                        <div className="flex items-center justify-center text-pubmatic-navy font-bold">
                            <Layers size={16} className="mr-2 text-pubmatic-teal" />
                            {result.apps.length}
                        </div>
                    </div>
                </div>
              </div>
          </div>

          {/* Apps Table Card */}
          <div className="bg-white rounded-xl shadow-card border border-pubmatic-border overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                <h3 className="font-bold text-pubmatic-navy">Discovered Applications</h3>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-gray-500 bg-white px-2 py-1 rounded border border-gray-200">
                      {result.apps.length} Results
                  </span>
                </div>
            </div>
            
            {result.apps.length === 0 ? (
               <div className="p-12 text-center text-gray-400">
                  <Layers size={48} className="mx-auto mb-3 opacity-20" />
                  <p>No apps found or failed to parse app list.</p>
               </div>
            ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-pubmatic-lightBlue text-pubmatic-navy text-xs uppercase tracking-wider font-bold">
                    <th className="px-6 py-4 rounded-tl-lg">App Name</th>
                    <th className="px-6 py-4">Store URL</th>
                    <th className="px-6 py-4">Developer Website</th>
                    <th className="px-6 py-4">ads.txt URL</th>
                    <th className="px-6 py-4 rounded-tr-lg">Status</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {result.apps.map((app, index) => (
                    <tr 
                        key={index} 
                        className="border-b border-gray-50 last:border-0 hover:bg-blue-50/30 transition-colors odd:bg-white even:bg-gray-50/30"
                    >
                      <td className="px-6 py-4">
                        <div className="font-medium text-gray-800">{app.appName}</div>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        {app.storeUrl ? (
                            <a 
                                href={app.storeUrl} 
                                target="_blank" 
                                rel="noreferrer" 
                                className="hover:text-pubmatic-blue flex items-center break-all"
                            >
                                {app.storeUrl} <ExternalLink size={10} className="ml-1 shrink-0" />
                            </a>
                        ) : '-'}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        {app.developerWebsite ? (
                            <a 
                                href={app.developerWebsite} 
                                target="_blank" 
                                rel="noreferrer"
                                className="hover:text-pubmatic-blue hover:underline truncate max-w-[200px] block"
                            >
                                {app.developerWebsite}
                            </a>
                        ) : (
                            <span className="text-gray-400 italic">Not found</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                         {app.adsTxtUrl ? (
                             <a 
                                href={app.adsTxtUrl} 
                                target="_blank" 
                                rel="noreferrer" 
                                className="hover:text-pubmatic-blue hover:underline bg-gray-100 px-2 py-1 rounded truncate max-w-[250px] block" 
                                title={app.adsTxtUrl}
                             >
                                {app.adsTxtUrl}
                             </a>
                         ) : (
                             <span className="text-gray-300">-</span>
                         )}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        <StatusBadge status={app.adsTxtStatus} code={app.adsTxtStatusCode} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
            
            <div className="bg-gray-50 px-6 py-3 border-t border-gray-100 text-xs text-gray-400 text-right">
                Generated at {new Date().toLocaleTimeString()}
            </div>
          </div>

          {/* Email Generator Module */}
          <div className="bg-white rounded-xl shadow-card border border-pubmatic-border overflow-hidden">
             <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                <div className="flex items-center gap-2">
                    <Mail size={18} className="text-pubmatic-blue" />
                    <h3 className="font-bold text-pubmatic-navy">Outreach Email Generator</h3>
                </div>
                <Button 
                    variant="secondary" 
                    size="sm" 
                    onClick={handleCopyEmail}
                    icon={copied ? <Check size={14} /> : <Copy size={14} />}
                >
                    {copied ? 'Copied!' : 'Copy to Clipboard'}
                </Button>
            </div>
            <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-8">
                
                {/* Configuration Panel */}
                <div className="space-y-4 bg-gray-50 p-4 rounded-lg border border-gray-100">
                    <div className="flex items-center mb-2">
                        <Settings size={14} className="text-gray-400 mr-2" />
                        <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Template Variables</h4>
                    </div>
                    
                    <div>
                        <label className="block text-xs font-semibold text-gray-600 mb-1">Integration Type</label>
                        <select 
                            value={variables.sdkName}
                            onChange={(e) => handleVariableChange('sdkName', e.target.value)}
                            className="w-full text-sm p-2 border border-gray-300 rounded focus:border-pubmatic-blue outline-none bg-white"
                        >
                            <option value="OpenWrap SDK">OpenWrap SDK</option>
                            <option value="Prebid">Prebid</option>
                            <option value="OW">OW</option>
                            <option value="ORTB">ORTB</option>
                            <option value="Tag based">Tag based</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs font-semibold text-gray-600 mb-1">Mediation Partner</label>
                        <select 
                            value={variables.mediationPartner}
                            onChange={(e) => handleVariableChange('mediationPartner', e.target.value)}
                            className="w-full text-sm p-2 border border-gray-300 rounded focus:border-pubmatic-blue outline-none bg-white"
                        >
                            <option value="MAX mediation">MAX mediation</option>
                            <option value="LevelPlay Mediation">LevelPlay Mediation</option>
                            <option value="In-house ad server">In-house ad server</option>
                            <option value="GAM as ad server">GAM as ad server</option>
                            <option value="Admob Mediation">Admob Mediation</option>
                            <option value="none">none</option>
                        </select>
                    </div>
                    <div className="border-t border-gray-200 pt-3">
                         <label className="block text-xs font-semibold text-gray-600 mb-1">Developer Account URL</label>
                         <input 
                            type="text" 
                            value={variables.developerAccountUrl}
                            onChange={(e) => handleVariableChange('developerAccountUrl', e.target.value)}
                            className="w-full text-xs p-2 border border-gray-300 rounded bg-white text-gray-500 focus:border-pubmatic-blue outline-none"
                         />
                    </div>
                    <div>
                         <label className="block text-xs font-semibold text-gray-600 mb-1">Ads.txt Text</label>
                         <textarea 
                            value={variables.adsTxtUrlString}
                            onChange={(e) => handleVariableChange('adsTxtUrlString', e.target.value)}
                            rows={2}
                            className="w-full text-xs p-2 border border-gray-300 rounded bg-white text-gray-500 focus:border-pubmatic-blue outline-none resize-none"
                         />
                    </div>
                    <div>
                         <label className="block text-xs font-semibold text-gray-600 mb-1">Bundle List</label>
                         <textarea 
                            value={variables.bundleList}
                            onChange={(e) => handleVariableChange('bundleList', e.target.value)}
                            rows={6}
                            className="w-full text-xs p-2 border border-gray-300 rounded bg-white text-gray-500 focus:border-pubmatic-blue outline-none font-mono"
                         />
                    </div>
                </div>

                {/* Preview Panel */}
                <div className="lg:col-span-2">
                    <div className="flex justify-between items-center mb-2">
                        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Email Preview & Edit</label>
                        <span className="text-[10px] text-gray-400 flex items-center">
                            <RefreshCw size={10} className="mr-1" /> Auto-updates with config
                        </span>
                    </div>
                    <textarea 
                        className="w-full h-[500px] p-4 rounded-lg border border-gray-200 font-mono text-sm text-gray-700 focus:border-pubmatic-blue focus:ring-2 focus:ring-pubmatic-blue/20 outline-none resize-none bg-white"
                        value={emailDraft}
                        onChange={(e) => setEmailDraft(e.target.value)}
                    />
                </div>
            </div>
          </div>

        </div>
      )}
    </div>
  );
};