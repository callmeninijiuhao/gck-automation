import React from 'react';
import { CheckCircle2, XCircle, AlertCircle } from 'lucide-react';

interface StatusBadgeProps {
  status: 'success' | 'failed' | 'pending';
  code?: number;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, code }) => {
  if (status === 'success') {
    return (
      <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 border border-green-200">
        <CheckCircle2 size={12} className="mr-1.5" />
        Success (200)
      </span>
    );
  }

  if (status === 'failed') {
    return (
      <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800 border border-red-200">
        <XCircle size={12} className="mr-1.5" />
        Failed {code ? `(${code})` : ''}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800 border border-gray-200">
      <AlertCircle size={12} className="mr-1.5" />
      Pending
    </span>
  );
};