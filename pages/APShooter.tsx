import React, { useState, useRef } from 'react';
import { ArrowRight } from 'lucide-react';
import StepIndicator from '@/components/ap-shooter/StepIndicator';
import WantedListUploader from '@/components/ap-shooter/WantedListUploader';
import PublisherListInput from '@/components/ap-shooter/PublisherListInput';
import APIConfig from '@/components/ap-shooter/APIConfig';
import FetchProgress from '@/components/ap-shooter/FetchProgress';
import GapAnalysis from '@/components/ap-shooter/GapAnalysis';
import OutreachMessages, { DEFAULT_TEMPLATE } from '@/components/ap-shooter/OutreachMessages';
import { fetchAllPublishers, fetchPublisherDeals, type ApiConfig as ApiConfigType } from '@/services/ap-shooter/apiFetcher';
import { calculateGaps } from '@/services/ap-shooter/gapCalculator';
import type { MappedDeal } from '@/services/ap-shooter/csvParser';
import type { GapDataItem } from '@/services/ap-shooter/exportCsv';

const today = new Date();
const dayBeforeYesterday = new Date(today);
dayBeforeYesterday.setDate(today.getDate() - 2);

const sevenDaysBefore = new Date(dayBeforeYesterday);
sevenDaysBefore.setDate(dayBeforeYesterday.getDate() - 6);

const formatDateLocal = (d: Date) => d.toISOString().split('T')[0];

const DEFAULT_PUBMATIC_URL = 'https://api.pubmatic.com/v1/analytics/data/publisher/{pub_id}?fromDate={from_date}T00:00&toDate={to_date}T23:59&dimensions=dealMetaId,date&metrics=revenue,paidImpressions,ecpm';

interface UploaderSavedState {
  file: File | null;
  headers: string[];
  rawRows: Record<string, unknown>[];
  mappings: {
    dealIdCol: string;
    dealNameCol: string;
    ownerCol: string;
    ownerMetaCol: string;
    pubIdCol: string;
    revenueCol: string;
  };
}

interface LogEntry {
  timestamp: string;
  type: 'info' | 'success' | 'error';
  text: string;
}

export const APShooter: React.FC = () => {
  const [step, setStep] = useState(1);
  const [hasUploaded, setHasUploaded] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  const [wantedDeals, setWantedDeals] = useState<MappedDeal[]>([]);
  const [uploaderSavedState, setUploaderSavedState] = useState<UploaderSavedState | null>(null);

  const [publishers, setPublishers] = useState<string[]>([]);
  const [publisherText, setPublisherText] = useState('');

  const loadSavedApiConfig = (): Partial<ApiConfigType> => {
    try {
      const raw = localStorage.getItem('ap_shooter_api_config');
      if (raw) return JSON.parse(raw);
    } catch {
      // ignore parse errors
    }
    return {};
  };

  const savedApiConfig = loadSavedApiConfig();

  const [apiConfig, setApiConfig] = useState<ApiConfigType>({
    baseUrl: savedApiConfig.baseUrl ?? DEFAULT_PUBMATIC_URL,
    jsonPath: savedApiConfig.jsonPath ?? 'rows',
    delayMs: savedApiConfig.delayMs ?? 200,
    concurrency: savedApiConfig.concurrency ?? 5,
    demoMode: savedApiConfig.demoMode ?? false,
    fromDate: savedApiConfig.fromDate ?? formatDateLocal(sevenDaysBefore),
    toDate: savedApiConfig.toDate ?? formatDateLocal(dayBeforeYesterday),
    authToken: savedApiConfig.authToken ?? ''
  });

  const persistApiConfig = (config: ApiConfigType) => {
    localStorage.setItem('ap_shooter_api_config', JSON.stringify(config));
  };

  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<Array<{ publisherId: string; success: boolean; dealsCount?: number; error?: string }> | null>(null);
  const [verifyPublisherId, setVerifyPublisherId] = useState<string | null>(null);

  const [isFetching, setIsFetching] = useState(false);
  const [fetchLog, setFetchLog] = useState<LogEntry[]>([]);
  const [completedCount, setCompletedCount] = useState(0);
  const [monetizingMap, setMonetizingMap] = useState<Record<string, string[]>>({});
  const [fetchStatusMap, setFetchStatusMap] = useState<Record<string, { status: string; errorMsg: string }>>({});
  const cancelRef = useRef<{ cancelled: boolean } | null>(null);

  const [gapResults, setGapResults] = useState<{
    stats: { totalPublishers: number; publishersWithGaps: number; totalGaps: number; totalMissingRevenue: number };
    gapData: GapDataItem[];
  }>({
    stats: { totalPublishers: 0, publishersWithGaps: 0, totalGaps: 0, totalMissingRevenue: 0 },
    gapData: []
  });

  const [outreachTemplate, setOutreachTemplate] = useState(DEFAULT_TEMPLATE);

  const extractPublisherIdFromUrl = (url: string) => {
    if (!url) return null;
    const match = url.match(/(?:publishers|publisher)\/([a-zA-Z0-9_-]+)/i);
    if (match && match[1]) {
      return match[1];
    }
    return null;
  };

  const handleUploadComplete = ({ wantedDeals: parsedDeals, detectedPublishers, rawState }: {
    wantedDeals: MappedDeal[];
    detectedPublishers: string[];
    rawState: UploaderSavedState;
  }) => {
    setWantedDeals(parsedDeals);
    setHasUploaded(true);
    setUploaderSavedState(rawState);

    if (detectedPublishers.length > 0) {
      setPublishers(detectedPublishers);
      setPublisherText(detectedPublishers.join('\n'));
    }

    setStep(2);
  };

  const handleStartFetch = async (overridePubs?: string[]) => {
    const targetPubs = overridePubs || publishers;
    setIsFetching(true);
    setCompletedCount(0);
    setFetchLog([]);
    setHasFetched(false);

    const controlSignal = { cancelled: false };
    cancelRef.current = controlSignal;

    const newFetchStatusMap: Record<string, { status: string; errorMsg: string }> = {};
    const formatTime = () => new Date().toLocaleTimeString();

    const handleProgress = (pubId: string, status: 'fetching' | 'success' | 'error', details: string, _resultDealsCount?: number) => {
      setFetchLog(prev => [
        ...prev,
        {
          timestamp: formatTime(),
          type: status === 'success' ? 'success' : status === 'error' ? 'error' : 'info',
          text: `[${pubId}] ${details}`
        }
      ]);

      if (status === 'success' || status === 'error') {
        newFetchStatusMap[pubId] = {
          status,
          errorMsg: status === 'error' ? details : ''
        };
        setCompletedCount(c => c + 1);
      }
    };

    try {
      const results = await fetchAllPublishers({
        publishers: targetPubs,
        apiConfig,
        controlSignal,
        onProgress: handleProgress
      });

      if (!controlSignal.cancelled) {
        setMonetizingMap(results);
        setFetchStatusMap(newFetchStatusMap);

        const gaps = calculateGaps(wantedDeals, results, newFetchStatusMap);
        setGapResults(gaps);

        setHasFetched(true);
        setIsFetching(false);
      }
    } catch (err) {
      setFetchLog(prev => [
        ...prev,
        { timestamp: formatTime(), type: 'error', text: `[FATAL] Pipeline error: ${err instanceof Error ? err.message : String(err)}` }
      ]);
      setIsFetching(false);
    }
  };

  const handleCancelFetch = () => {
    if (cancelRef.current) {
      cancelRef.current.cancelled = true;
    }
    setIsFetching(false);
    setFetchLog(prev => [
      ...prev,
      { timestamp: new Date().toLocaleTimeString(), type: 'error', text: '[SYSTEM] Fetch process cancelled by user.' }
    ]);
  };

  const handleBackFromVerify = () => {
    setIsVerifying(false);
    setVerifyResult(null);
    setVerifyPublisherId(null);
  };

  const handleVerifyApi = async (targetPubs: string[]) => {
    setIsVerifying(true);
    setVerifyResult(null);
    setVerifyPublisherId(null);

    const results = await Promise.all(
      targetPubs.map(async (pubId) => {
        try {
          const deals = await fetchPublisherDeals(pubId, apiConfig);
          return { publisherId: pubId, success: true, dealsCount: deals.length };
        } catch (err) {
          let errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg === 'Failed to fetch' || errMsg === 'Load failed') {
            errMsg = 'Failed to fetch (Network error, CORS issue, or server unreachable)';
          }
          return { publisherId: pubId, success: false, error: errMsg };
        }
      })
    );

    setVerifyResult(results);
  };

  const handleResetFetch = () => {
    setCompletedCount(0);
    setFetchLog([]);
    setHasFetched(false);
    setIsVerifying(false);
    setVerifyResult(null);
    setVerifyPublisherId(null);
    setStep(3);
  };

  const handleBackFromFetch = () => {
    setHasFetched(false);
    setIsVerifying(false);
    setStep(3);
  };

  const navigateToStep = (targetStep: number) => {
    if (isFetching) return;
    if (targetStep !== 3) {
      setIsVerifying(false);
      setVerifyResult(null);
      setVerifyPublisherId(null);
    }
    setStep(targetStep);
  };

  const hasPublishers = publishers.length > 0;

  return (
    <div className="ap-shooter-scope">
      <div className="page-header">
        <h1>Auction Package Analyzer</h1>
        <p>Audit publisher monetizing packages against wanted deal distributions</p>
      </div>

      <StepIndicator
        currentStep={step === 3 && isFetching ? 3 : step}
        onStepClick={navigateToStep}
        hasUploaded={hasUploaded}
        hasPublishers={hasPublishers}
        hasFetched={hasFetched}
      />

      <main style={{ minHeight: '500px' }}>

        {step === 1 && (
          <div className="animated-fade-in">
            <WantedListUploader
              onUploadComplete={handleUploadComplete}
              savedState={uploaderSavedState}
            />
          </div>
        )}

        {step === 2 && (
          <PublisherListInput
            initialPublishers={publishers}
            text={publisherText}
            onTextChange={setPublisherText}
            onChange={(pubs) => setPublishers(pubs)}
            onNext={() => setStep(3)}
            onPrev={() => setStep(1)}
          />
        )}

        {step === 3 && (
          <>
            {!isVerifying && !isFetching && !hasFetched ? (
              <APIConfig
                apiConfig={apiConfig}
                onConfigChange={(config) => {
                  setApiConfig(config);
                  persistApiConfig(config);
                }}
                onNext={() => {
                  let activePubs = [...publishers];
                  if (activePubs.length === 0) {
                    const extracted = extractPublisherIdFromUrl(apiConfig.baseUrl);
                    if (extracted) {
                      activePubs = [extracted];
                      setPublishers(activePubs);
                    } else {
                      activePubs = ['Default Publisher'];
                      setPublishers(activePubs);
                    }
                  }
                  handleVerifyApi(activePubs);
                }}
                onPrev={() => setStep(2)}
              />
            ) : isVerifying && !isFetching ? (
              <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                <div>
                  <h2 style={{ fontSize: 'var(--text-h3)', fontWeight: 600 }}>
                    {verifyResult
                      ? (verifyResult.every(r => r.success) ? 'API Connection Verified' : 'API Verification Failed')
                      : 'Verifying API Connection...'}
                  </h2>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    {verifyResult
                      ? verifyResult.every(r => r.success)
                        ? `The test calls succeeded for all ${verifyResult.length} publisher(s). Review the summary below before running the full batch.`
                        : 'One or more test calls failed. Please review your API configuration and try again.'
                      : `Sending pre-flight test requests to validate the endpoint and date range for ${publishers.length} publisher(s)...`}
                  </p>
                </div>

                {verifyResult && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {verifyResult.map((r) => (
                      <div key={r.publisherId} style={{
                        padding: '1rem 1.25rem',
                        borderRadius: '0.625rem',
                        border: `1px solid ${r.success ? 'var(--success)' : 'var(--error)'}`,
                        background: r.success ? 'var(--success-subtle)' : 'var(--error-subtle)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.5rem'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600, color: r.success ? 'var(--success)' : 'var(--error)' }}>
                          {r.success ? '✓' : '✗'} {r.success ? 'HTTP 200 OK' : 'Connection Error'}
                        </div>
                        {r.success ? (
                          <>
                            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                              <strong>Publisher:</strong> <code>{r.publisherId}</code>
                            </div>
                            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                              <strong>Deals Found:</strong> {r.dealsCount}
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                            <strong>Publisher:</strong> <code>{r.publisherId}</code><br />
                            <strong>Error:</strong> {r.error}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {!verifyResult && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                    <span className="spinner" style={{
                      display: 'inline-block',
                      width: '16px',
                      height: '16px',
                      border: '2px solid var(--border-strong)',
                      borderRadius: '50%',
                      borderTopColor: 'var(--primary)',
                      animation: 'ap-spin 0.8s linear infinite'
                    }} />
                    Testing with publisher: {verifyPublisherId || extractPublisherIdFromUrl(apiConfig.baseUrl) || 'Default Publisher'}
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: '1.5rem', marginTop: '0.5rem' }}>
                  <button className="btn btn-secondary" onClick={handleBackFromVerify} disabled={!verifyResult}>
                    Back to Config
                  </button>
                  <div style={{ display: 'flex', gap: '1rem' }}>
                    {verifyResult?.every(r => r.success) && (
                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          setIsVerifying(false);
                          handleStartFetch(publishers);
                        }}
                      >
                        Run Full Fetch <ArrowRight size={16} />
                      </button>
                    )}
                    {verifyResult && !verifyResult.every(r => r.success) && (
                      <button className="btn btn-secondary" onClick={() => { setVerifyResult(null); handleVerifyApi(publishers.length > 0 ? publishers : [verifyPublisherId || 'Default Publisher']); }}>
                        Retry Test
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <FetchProgress
                isFetching={isFetching}
                logs={fetchLog}
                completedCount={completedCount}
                totalCount={publishers.length}
                onCancel={handleCancelFetch}
                onProceed={() => setStep(4)}
                onReset={handleResetFetch}
                onBackToConfig={handleBackFromFetch}
              />
            )}
          </>
        )}

        {step === 4 && (
          <GapAnalysis
            stats={gapResults.stats}
            gapData={gapResults.gapData}
            onProceed={() => setStep(5)}
            onPrev={() => setStep(3)}
          />
        )}

        {step === 5 && (
          <OutreachMessages
            gapData={gapResults.gapData}
            onPrev={() => setStep(4)}
            template={outreachTemplate}
            onTemplateChange={setOutreachTemplate}
          />
        )}

      </main>

    </div>
  );
};
