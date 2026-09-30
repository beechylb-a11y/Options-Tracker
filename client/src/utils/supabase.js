import { createClient } from '@supabase/supabase-js';
import { api } from './api';

// The Supabase project URL + publishable key come from the server (/auth/config)
// so they live in one place (Railway env) and never need a client rebuild.
let clientPromise = null;
export function getSupabase() {
  if (!clientPromise) {
    clientPromise = api.authConfig().then(({ supabaseUrl, publishableKey }) => {
      if (!supabaseUrl || !publishableKey) throw new Error('Server is missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY');
      return createClient(supabaseUrl, publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ot-auth' }
      });
    });
    clientPromise.catch(() => { clientPromise = null; });
  }
  return clientPromise;
}
