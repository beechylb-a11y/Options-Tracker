import React from 'react';

export default function ErrorBanner({ message, onRetry }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-red/10 border border-red/30 text-red text-sm rounded-lg px-4 py-2 mb-4">
      <span>{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="text-xs underline hover:opacity-80 shrink-0">
          Retry
        </button>
      )}
    </div>
  );
}
