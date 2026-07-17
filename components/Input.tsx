import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  icon?: React.ReactNode;
}

export const Input: React.FC<InputProps> = ({ label, error, icon, className, ...props }) => {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-semibold text-pubmatic-navy mb-2">
          {label}
        </label>
      )}
      <div className="relative">
        {icon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
            {icon}
          </div>
        )}
        <input
          className={`
            w-full py-3 rounded-lg border bg-white transition-all duration-200 outline-none
            text-pubmatic-text placeholder-gray-400
            focus:border-pubmatic-blue focus:ring-2 focus:ring-pubmatic-blue/20
            disabled:bg-gray-100 disabled:text-gray-400
            ${icon ? 'pl-10 pr-4' : 'px-4'}
            ${error ? 'border-red-500 focus:ring-red-200' : 'border-pubmatic-border'}
            ${className}
          `}
          {...props}
        />
      </div>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
};