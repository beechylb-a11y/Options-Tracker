export function fmt$(n) {
  if (n == null || isNaN(n)) return '--';
  const abs = Math.abs(n);
  return (n < 0 ? '-$' : '$') + abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function fmtPct(n) {
  if (n == null || isNaN(n)) return '--';
  return (n * 100).toFixed(1) + '%';
}

export function fmtDate(d) {
  if (!d) return '--';
  const date = new Date(d);
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateShort(d) {
  if (!d) return '--';
  const date = new Date(d);
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

export function pnlClass(n) {
  if (n > 0) return 'green';
  if (n < 0) return 'red';
  return '';
}

export function pnlColor(n) {
  if (n > 0) return '#3fb950';
  if (n < 0) return '#f85149';
  return '#8b949e';
}

export function filterByAccount(trades, account) {
  if (!account || account === 'all') return trades;
  return trades.filter(t => {
    const tradeAccount = t.Account || t['Account'] || '';
    return tradeAccount === account;
  });
}
