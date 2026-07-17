import React, { useState } from 'react';
import {
    Search,
    AlertTriangle,
    Check,
    Globe,
    ArrowRight,
    Building2,
    Database,
    ShieldAlert,
    Target,
    ListOrdered,
    Crosshair
} from 'lucide-react';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { fetchSellersJson, searchBSellers, SellerResult } from '../services/sellerService';

export const SellerDomainShooter: React.FC = () => {
    // Inputs
    const [competitorDomain, setCompetitorDomain] = useState('');
    const [entityName, setEntityName] = useState('');

    // State
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [results, setResults] = useState<SellerResult[]>([]);
    const [searched, setSearched] = useState(false);
    const [fetchedDomain, setFetchedDomain] = useState('');

    const handleAnalyze = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!competitorDomain || !entityName) {
            setError("Please provide both Competitor Domain and Entity Name.");
            return;
        }

        setLoading(true);
        setError(null);
        setResults([]);
        setSearched(false);

        try {
            const sellers = await fetchSellersJson(competitorDomain);
            const matches = searchBSellers(sellers, entityName);

            setResults(matches);
            setFetchedDomain(competitorDomain);
            setSearched(true);
        } catch (err: any) {
            setError(err.message || "Failed to fetch or parse sellers.json");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-8 animate-fade-in">
            {/* Header Section */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-pubmatic-navy tracking-tight">Seller Domain Shooter</h1>
                    <p className="text-gray-500 mt-2">Search competitor sellers.json files to verify publisher presence and troubleshoot domain mismatches.</p>
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
                                Quickly determine whether a specific publisher or developer entity is listed inside a competitor's <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">sellers.json</code> file. This is especially useful when a demand-side platform (e.g., TTD) has blocked a seller domain, yet the same bundle or app inventory is still being transacted through other intermediaries — indicating the publisher may remain active under a different seller ID or domain within another competitor's file. This helps troubleshoot domain mismatches, verify supply path transparency, and identify indirect inventory sources during onboarding or competitive analysis.
                            </p>
                        </div>
                        <div>
                            <h3 className="text-sm font-bold text-pubmatic-navy mb-3 flex items-center gap-2">
                                <ListOrdered size={16} className="text-pubmatic-teal" />
                                How to Use
                            </h3>
                            <ol className="text-sm text-gray-600 leading-relaxed space-y-2 list-decimal list-inside">
                                <li><strong>Enter Competitor Domain</strong> — Input the competitor's root domain (e.g., <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">inmobi.com</code>).</li>
                                <li><strong>Enter Entity Name</strong> — Type the publisher or developer name you want to search for (e.g., <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">Learnings</code>).</li>
                                <li><strong>Shoot & Analyze</strong> — The tool fetches the competitor's <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">sellers.json</code> and searches for matching entries.</li>
                                <li><strong>Review Results</strong> — Inspect seller IDs, names, domains, and seller types to understand the relationship.</li>
                            </ol>
                        </div>
                    </div>
                </div>
            </div>

            <div className="space-y-8">

                {/* Quick Tips + Common Domains */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="bg-white rounded-xl shadow-card border border-pubmatic-border overflow-hidden">
                        <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-4">
                            <h3 className="font-bold text-pubmatic-navy flex items-center gap-2 text-sm">
                                <ArrowRight size={16} className="text-pubmatic-teal" />
                                Quick Tips
                            </h3>
                        </div>
                        <div className="p-6">
                            <ul className="space-y-3 text-sm text-gray-600">
                                <li className="flex items-start gap-2">
                                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-pubmatic-teal shrink-0"></span>
                                    <span>Enter just the root domain (e.g. <code className="bg-gray-50 px-1 py-0.5 rounded text-xs border border-gray-200">magnite.com</code>) — the tool will try common paths automatically.</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-pubmatic-teal shrink-0"></span>
                                    <span>Use partial entity names for broader matches (e.g. "Learning" catches "Learnings Inc").</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-pubmatic-teal shrink-0"></span>
                                    <span>If a domain fails, try adding <code className="bg-gray-50 px-1 py-0.5 rounded text-xs border border-gray-200">www.</code> or the full <code className="bg-gray-50 px-1 py-0.5 rounded text-xs border border-gray-200">sellers.json</code> URL.</span>
                                </li>
                            </ul>
                        </div>
                    </div>

                    <div className="bg-white rounded-xl shadow-card border border-pubmatic-border overflow-hidden">
                        <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-4">
                            <h3 className="font-bold text-pubmatic-navy text-sm">Common Domains</h3>
                        </div>
                        <div className="p-6">
                            <div className="flex flex-wrap gap-2">
                                {['inmobi.com', 'magnite.com', 'pubmatic.com', 'indexexchange.com', 'openx.com'].map(d => (
                                    <button
                                        key={d}
                                        onClick={() => setCompetitorDomain(d)}
                                        className="px-3 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded-md text-gray-600 hover:border-pubmatic-blue hover:text-pubmatic-blue transition-colors"
                                    >
                                        {d}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Main Module: Seller Domain Shooter */}
                <div className="w-full">
                    <div className="bg-white rounded-xl shadow-card border border-pubmatic-border overflow-hidden">
                        <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-4 flex justify-between items-center">
                            <h3 className="font-bold text-pubmatic-navy flex items-center gap-2">
                                <Crosshair size={18} className="text-pubmatic-teal" />
                                Shoot Analysis
                            </h3>
                        </div>

                        <div className="p-8">
                            <p className="text-sm text-gray-500 mb-6">
                                Verify if a specific publisher entity exists in a competitor's <code>sellers.json</code> file to troubleshoot domain mismatches.
                            </p>

                            <form onSubmit={handleAnalyze} className="space-y-4">
                                <div className="grid grid-cols-2 gap-4">
                                    <Input
                                        label="Competitor Domain / URL"
                                        placeholder="e.g. inmobi.com"
                                        value={competitorDomain}
                                        onChange={(e) => setCompetitorDomain(e.target.value)}
                                        icon={<Globe size={16} />}
                                    />
                                    <Input
                                        label="Developer / Entity Name"
                                        placeholder="e.g. Learnings"
                                        value={entityName}
                                        onChange={(e) => setEntityName(e.target.value)}
                                        icon={<Building2 size={16} />}
                                    />
                                </div>

                                <div className="flex justify-end">
                                    <Button
                                        type="submit"
                                        isLoading={loading}
                                        icon={<Search size={16} />}
                                    >
                                        Shoot & Analyze
                                    </Button>
                                </div>
                            </form>

                            {error && (
                                <div className="mt-6 p-4 bg-red-50 border border-red-100 rounded-lg text-red-700 text-sm flex items-start animate-fade-in-up">
                                    <div className="mr-3 bg-red-100 p-1.5 rounded-full shrink-0"><AlertTriangle size={14} /></div>
                                    <span>{error}</span>
                                </div>
                            )}

                            {searched && (
                                <div className="mt-8 animate-fade-in-up">
                                    <div className="flex items-center justify-between mb-4">
                                        <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide">
                                            Results for "{entityName}"
                                        </h4>
                                        <span className={`text-xs px-2 py-1 rounded-full border ${results.length > 0 ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
                                            {results.length} Matches Found
                                        </span>
                                    </div>

                                    {results.length > 0 ? (
                                        <div className="border border-gray-200 rounded-lg overflow-hidden">
                                            <table className="w-full text-left text-sm">
                                                <thead className="bg-gray-50 text-gray-500 font-semibold border-b border-gray-200">
                                                    <tr>
                                                        <th className="px-4 py-3">Seller ID</th>
                                                        <th className="px-4 py-3">Name</th>
                                                        <th className="px-4 py-3">Domain</th>
                                                        <th className="px-4 py-3">Type</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-gray-100 bg-white">
                                                    {results.map((r, i) => (
                                                        <tr key={i} className="hover:bg-blue-50/30 transition-colors">
                                                            <td className="px-4 py-3 font-mono text-xs text-gray-600 select-all">{r.sellerId}</td>
                                                            <td className="px-4 py-3 font-medium text-pubmatic-navy">{r.name}</td>
                                                            <td className="px-4 py-3 text-gray-600">{r.domain}</td>
                                                            <td className="px-4 py-3">
                                                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800">
                                                                    {r.sellerType}
                                                                </span>
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    ) : (
                                        <div className="text-center py-8 bg-gray-50 rounded-lg border border-dashed border-gray-200">
                                            <Database size={32} className="mx-auto text-gray-300 mb-2" />
                                            <p className="text-gray-500 font-medium">No matching sellers found.</p>
                                            <p className="text-xs text-gray-400 mt-1">Try refining your entity name search (e.g. "Learning" instead of "Learnings")</p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

