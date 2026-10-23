import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false },
  }
);

const files = [
  ['baselines', './data/baselines.json'],
  ['transactions', './data/transactions.json'],
  ['uploads', './data/uploads.json'],
  ['price-cache', './data/price-cache.json'],
  ['price-range-cache', './data/price-range-cache.json'],
];

for (const [key, filePath] of files) {
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const { error } = await supabase.from('cache_documents').upsert([
    { key, value: json }
  ]);

  if (error) {
    console.error('Failed to insert', key, error);
    process.exit(1);
  }

  console.log('Inserted', key);
}

console.log('Done');