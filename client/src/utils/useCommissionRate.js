import { useEffect, useState } from 'react';
import { api } from './api';
import { commissionRate, DEFAULT_COMMISSION } from './commission';

// The commission rate for an account id, read once from Settings and shared.
// Falls back to the default until the account list arrives (or when no account).
let cache = null, pending = null;
function load() {
  if (cache) return Promise.resolve(cache);
  if (!pending) pending = api.getAccounts().then(a => { cache = Array.isArray(a) ? a : []; return cache; })
    .catch(() => { pending = null; return []; });
  return pending;
}
export function invalidateCommissionRates() { cache = null; pending = null; }

export function useCommissionRate(accountId) {
  const pick = list => commissionRate((list || []).find(a => a.id === accountId));
  const [rate, setRate] = useState(() => (cache ? pick(cache) : DEFAULT_COMMISSION));
  useEffect(() => {
    let live = true;
    load().then(list => { if (live) setRate(pick(list)); });
    return () => { live = false; };
  }, [accountId]);
  return rate;
}
