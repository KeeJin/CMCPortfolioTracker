# Backend Environment Files

This backend now has two environment templates for two different workflows.

## 1) Lightweight hosted backend server

Template: `.env.server.example`

Copy to your runtime env source (for local use `.env`, for Render set the same keys in Render Environment Variables):

- `PORT`
- `NODE_ENV`
- `SESSION_SECRET`
- `GOOGLE_CLIENT_ID`
- `ALLOWED_GOOGLE_EMAIL`
- `FRONTEND_URL`
- `CORS_ORIGIN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ENABLE_BACKGROUND_PREFETCH=false`

## 2) Manual processed-cache refresh script

Template: `.env.manual-refresh.example`

This env is only for running:

- `npm run refresh:processed-cache`

Typical local flow:

1. Copy `.env.manual-refresh.example` to `.env.manual-refresh`
2. Fill in real Supabase values
3. Run:

```bash
DOTENV_CONFIG_PATH=.env.manual-refresh npm run refresh:processed-cache
```

The script reads/writes Supabase `cache_documents` keys such as:

- `portfolio_snapshot`
- `portfolio_history`
- `portfolio_value`
