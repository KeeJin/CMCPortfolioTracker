import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import authRouter from './routes/auth.js';
import transactionsRouter from './routes/transactions.js';
import baselineRouter from './routes/baseline.js';
import portfolioRouter from './routes/portfolio.js';
import { initStore } from './store.js';
import { loadPriceCache } from './priceCache.js';
import { requireAuth } from './middlewares/auth.js';

const app = express();
const port = Number(process.env.PORT) || 3001;
const allowedOrigins = new Set(
  [
    process.env.FRONTEND_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined,
    process.env.CORS_ORIGIN,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ].filter((value): value is string => Boolean(value)),
);

app.use(
  cors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS.`));
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

app.get('/api/health', (_req, res) => {
  const supabaseConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'portfolio-backend',
    supabaseConfigured,
  });
});

app.get('/api/health/db', async (_req, res) => {
  const supabaseConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!supabaseConfigured || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(200).json({
      status: 'degraded',
      database: 'not-configured',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/cache_documents?select=key&limit=1`, {
      method: 'GET',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });

    if (!response.ok) {
      res.status(503).json({
        status: 'error',
        database: 'unreachable',
        httpStatus: response.status,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(200).json({
      status: 'ok',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database health error';
    res.status(503).json({
      status: 'error',
      database: 'unreachable',
      error: message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.use('/api/auth', authRouter);
app.use(requireAuth);
app.use('/api/transactions', transactionsRouter);
app.use('/api/baseline', baselineRouter);
app.use('/api/portfolio', portfolioRouter);

// Load persisted store and price cache before accepting requests.
void (async () => {
  await initStore();
  void loadPriceCache();

  app.listen(port, () => {
    console.log(`Backend server is running on port ${port}`);
    console.log('[startup] Production mode: server-light, no eager prefetch startup hooks');
  });
})();
