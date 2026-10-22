import { jest } from '@jest/globals';

import { hydrateStoreFromSupabase, getAllBaselines, getAllTransactions, getAllUploads } from '../src/store.js';

describe('supabase store hydration', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('key=eq.baselines')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ key: 'baselines', value: [{ id: 'b1', date: '2024-01-01', holdings: { AAPL: 10 }, cash: 1000 }] }],
        } as Response);
      }

      if (url.includes('key=eq.transactions')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ key: 'transactions', value: [{ id: 't1', date: '2024-01-02', type: 'BUY', symbol: 'AAPL', quantity: 10, amount: -2000, price: 200 }] }],
        } as Response);
      }

      if (url.includes('key=eq.uploads')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ key: 'uploads', value: [{ id: 'u1', type: 'BASELINE', filename: 'demo.csv', uploadedAt: '2024-01-01T00:00:00.000Z' }] }],
        } as Response);
      }

      return Promise.resolve({ ok: true, json: async () => [] } as Response);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('loads persisted baselines, transactions, and uploads from Supabase cache_documents', async () => {
    await hydrateStoreFromSupabase();

    expect(getAllBaselines()).toHaveLength(1);
    expect(getAllTransactions()).toHaveLength(1);
    expect(getAllUploads()).toHaveLength(1);
  });
});
