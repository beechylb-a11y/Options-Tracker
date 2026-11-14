import { describe, it, expect } from 'vitest';
import { withBridgeKey } from '../utils/bridgeAuth';

const store = (o) => ({ getItem: k => (k in o ? o[k] : null) });
const S = store({ bridgeUrl: 'https://abc.ngrok-free.app', bridgeKey: 'k123' });

describe('withBridgeKey', () => {
  it('adds the key to bridge calls and keeps existing headers', () => {
    const init = withBridgeKey('https://abc.ngrok-free.app/api/health', { headers: { 'ngrok-skip-browser-warning': '1' } }, S);
    expect(init.headers.get('X-Bridge-Key')).toBe('k123');
    expect(init.headers.get('ngrok-skip-browser-warning')).toBe('1');
  });
  it('keeps method and body on POST', () => {
    const init = withBridgeKey('https://abc.ngrok-free.app/api/stage-order', { method: 'POST', body: '{}' }, S);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(init.headers.get('X-Bridge-Key')).toBe('k123');
  });
  it('never sends the key anywhere else', () => {
    const init = { headers: { a: '1' } };
    expect(withBridgeKey('/api/decisions', init, S)).toBe(init);
    expect(withBridgeKey('https://abc.ngrok-free.app.evil.com/api/health', init, S)).toBe(init);
  });
  it('does nothing without a key', () => {
    const init = {};
    expect(withBridgeKey('https://abc.ngrok-free.app/api/health', init, store({ bridgeUrl: 'https://abc.ngrok-free.app' }))).toBe(init);
  });
});
