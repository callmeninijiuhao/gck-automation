import React, { useState } from 'react';
import { Key, Eye, EyeOff, Copy, Check, AlertTriangle, Shield, Clock, Mail } from 'lucide-react';
import { generateToken, refreshToken, type GenerateTokenParams, type RefreshTokenParams, type TokenResponse } from '@/services/tokenManager';

interface TokenResult {
  accessToken: string;
  refreshToken: string;
  userEmail: string;
}

interface PasswordInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}

const PasswordInput: React.FC<PasswordInputProps> = ({ value, onChange, placeholder, required }) => {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        type={show ? 'text' : 'password'}
        className="input-text"
        style={{ paddingRight: '2.5rem' }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        style={{
          position: 'absolute',
          right: '0.625rem',
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text-muted)',
          padding: '0.25rem',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
};

interface TokenFieldProps {
  label: string;
  value: string;
}

const TokenField: React.FC<TokenFieldProps> = ({ label, value }) => {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="form-group" style={{ gap: '0.5rem' }}>
      <label className="form-label">{label}</label>
      <div style={{ position: 'relative' }}>
        <textarea
          className="textarea"
          readOnly
          value={revealed ? value : '•'.repeat(Math.min(value.length, 40))}
          style={{ minHeight: '60px', fontFamily: 'monospace', fontSize: '0.8125rem', paddingRight: '5rem' }}
        />
        <div style={{ position: 'absolute', right: '0.5rem', top: '0.5rem', display: 'flex', gap: '0.25rem' }}>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
            onClick={() => setRevealed(!revealed)}
          >
            {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
            onClick={handleCopy}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
};

export const TokenManager: React.FC = () => {
  // Generate token form state
  const [genEmail, setGenEmail] = useState('');
  const [genPassword, setGenPassword] = useState('');
  const [genApiProduct, setGenApiProduct] = useState('PUBLISHER');
  const [genAccountId, setGenAccountId] = useState('');
  const [genAccountType, setGenAccountType] = useState('');
  const [genLoading, setGenLoading] = useState(false);
  const [genResult, setGenResult] = useState<TokenResult | null>(null);
  const [genError, setGenError] = useState('');

  // Refresh token form state
  const [refEmail, setRefEmail] = useState('');
  const [refAccessToken, setRefAccessToken] = useState('');
  const [refRefreshToken, setRefRefreshToken] = useState('');
  const [refApiProduct, setRefApiProduct] = useState('PUBLISHER');
  const [refAccountId, setRefAccountId] = useState('');
  const [refAccountType, setRefAccountType] = useState('');
  const [refLoading, setRefLoading] = useState(false);
  const [refResult, setRefResult] = useState<TokenResult | null>(null);
  const [refError, setRefError] = useState('');

  const handleGenerate = async () => {
    setGenError('');
    setGenResult(null);
    setGenLoading(true);
    try {
      const params: GenerateTokenParams = {
        userName: genEmail,
        password: genPassword,
        apiProduct: genApiProduct,
      };
      if (genAccountId.trim()) params.accountId = genAccountId.trim();
      if (genAccountType.trim()) params.accountType = genAccountType.trim();
      const res = await generateToken(params);
      setGenResult({
        accessToken: res.accessToken,
        refreshToken: res.refreshToken,
        userEmail: res.userEmail,
      });
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Failed to generate token');
    } finally {
      setGenLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefError('');
    setRefResult(null);
    setRefLoading(true);
    try {
      const params: RefreshTokenParams = {
        email: refEmail,
        apiProduct: refApiProduct,
        accessToken: refAccessToken,
        refreshToken: refRefreshToken,
      };
      if (refAccountId.trim()) params.accountId = refAccountId.trim();
      if (refAccountType.trim()) params.accountType = refAccountType.trim();
      const res = await refreshToken(params);
      setRefResult({
        accessToken: res.accessToken,
        refreshToken: res.refreshToken,
        userEmail: res.userEmail,
      });
    } catch (err) {
      setRefError(err instanceof Error ? err.message : 'Failed to refresh token');
    } finally {
      setRefLoading(false);
    }
  };

  return (
    <div className="ap-shooter-scope">
      <div className="page-header">
        <h1>API Token Management</h1>
        <p>Generate and refresh your PubMatic API access tokens</p>
      </div>

      <div className="grid-2">
        {/* Generate Token Card */}
        <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Key style={{ color: 'var(--primary)' }} size={24} />
            <div>
              <h2 style={{ fontSize: 'var(--text-h3)', fontWeight: 600 }}>Generate Access Token</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                First-time token generation for new API users.
              </p>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Email <span style={{ color: 'var(--error)' }}>*</span></label>
            <input
              type="email"
              className="input-text"
              placeholder="your.work.email@company.com"
              value={genEmail}
              onChange={(e) => setGenEmail(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Password <span style={{ color: 'var(--error)' }}>*</span></label>
            <PasswordInput
              value={genPassword}
              onChange={setGenPassword}
              placeholder="Your PubMatic account password"
            />
          </div>

          <div className="form-group">
            <label className="form-label">API Product <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>(optional)</span></label>
            <input
              type="text"
              className="input-text"
              placeholder="PUBLISHER"
              value={genApiProduct}
              onChange={(e) => setGenApiProduct(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Account ID <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>(optional)</span></label>
            <input
              type="text"
              className="input-text"
              placeholder="e.g. 12345"
              value={genAccountId}
              onChange={(e) => setGenAccountId(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Account Type <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>(optional)</span></label>
            <input
              type="text"
              className="input-text"
              placeholder="e.g. DIRECT"
              value={genAccountType}
              onChange={(e) => setGenAccountType(e.target.value)}
            />
          </div>

          {genError && (
            <div style={{ background: 'var(--error-subtle)', border: '1px solid #fecaca', borderRadius: '0.625rem', padding: '0.75rem', color: 'var(--error)', fontSize: '0.875rem' }}>
              {genError}
            </div>
          )}

          {genResult && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ background: 'var(--success-subtle)', border: '1px solid #bbf7d0', borderRadius: '0.625rem', padding: '0.75rem', color: 'var(--success)', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Check size={16} />
                Token generated successfully. Copy and store both tokens securely — they will not be displayed again.
              </div>
              <TokenField label="Access Token" value={genResult.accessToken} />
              <TokenField label="Refresh Token" value={genResult.refreshToken} />
              <div className="form-group">
                <label className="form-label">User Email</label>
                <input type="text" className="input-text" readOnly value={genResult.userEmail} />
              </div>
            </div>
          )}

          <button
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={genLoading || !genEmail.trim() || !genPassword.trim()}
          >
            {genLoading ? 'Generating...' : 'Generate Token'}
          </button>
        </div>

        {/* Refresh Token Card */}
        <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Shield style={{ color: 'var(--primary)' }} size={24} />
            <div>
              <h2 style={{ fontSize: 'var(--text-h3)', fontWeight: 600 }}>Refresh Access Token</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                Refresh an existing token before the 60-day expiration.
              </p>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Email <span style={{ color: 'var(--error)' }}>*</span></label>
            <input
              type="email"
              className="input-text"
              placeholder="your.work.email@company.com"
              value={refEmail}
              onChange={(e) => setRefEmail(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Current Access Token <span style={{ color: 'var(--error)' }}>*</span></label>
            <PasswordInput
              value={refAccessToken}
              onChange={setRefAccessToken}
              placeholder="Used for Authorization header"
            />
          </div>

          <div className="form-group">
            <label className="form-label">Refresh Token <span style={{ color: 'var(--error)' }}>*</span></label>
            <PasswordInput
              value={refRefreshToken}
              onChange={setRefRefreshToken}
              placeholder="Your current refresh token"
            />
          </div>

          <div className="form-group">
            <label className="form-label">API Product <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>(optional)</span></label>
            <input
              type="text"
              className="input-text"
              placeholder="PUBLISHER"
              value={refApiProduct}
              onChange={(e) => setRefApiProduct(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Account ID <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>(optional)</span></label>
            <input
              type="text"
              className="input-text"
              placeholder="e.g. 12345"
              value={refAccountId}
              onChange={(e) => setRefAccountId(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Account Type <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>(optional)</span></label>
            <input
              type="text"
              className="input-text"
              placeholder="e.g. DIRECT"
              value={refAccountType}
              onChange={(e) => setRefAccountType(e.target.value)}
            />
          </div>

          {refError && (
            <div style={{ background: 'var(--error-subtle)', border: '1px solid #fecaca', borderRadius: '0.625rem', padding: '0.75rem', color: 'var(--error)', fontSize: '0.875rem' }}>
              {refError}
            </div>
          )}

          {refResult && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ background: 'var(--success-subtle)', border: '1px solid #bbf7d0', borderRadius: '0.625rem', padding: '0.75rem', color: 'var(--success)', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Check size={16} />
                Token refreshed successfully. Replace your old tokens with the new ones immediately.
              </div>
              <TokenField label="New Access Token" value={refResult.accessToken} />
              <TokenField label="New Refresh Token" value={refResult.refreshToken} />
            </div>
          )}

          <button
            className="btn btn-primary"
            onClick={handleRefresh}
            disabled={refLoading || !refEmail.trim() || !refAccessToken.trim() || !refRefreshToken.trim()}
          >
            {refLoading ? 'Refreshing...' : 'Refresh Token'}
          </button>
        </div>
      </div>

      {/* Info Card */}
      <div className="glass-card animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <AlertTriangle size={20} style={{ color: 'var(--warning)' }} />
          Security & Usage Notes
        </h2>
        <ul style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', lineHeight: 1.7, paddingLeft: '1.25rem', margin: 0 }}>
          <li>Access tokens expire every <strong>60 days</strong>. Set up a scheduled refresh every 55 days to prevent disruption.</li>
          <li><strong>200 token generation attempts within 20 minutes</strong> will automatically disable your account.</li>
          <li>After <strong>July 15, 2026</strong>, access tokens will no longer be sent via email. Retrieve them directly from this tool or the API response.</li>
          <li>One token provides access for <strong>all mapped publisher IDs</strong> associated with your user account.</li>
          <li>Store tokens securely — they are only displayed once. If lost, you must generate a new token.</li>
          <li>New users must first be registered as API users via the PubMatic UI or Media Buyer Console before generating a token.</li>
        </ul>
      </div>
    </div>
  );
};
