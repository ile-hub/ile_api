// Explicitly approved isolated-only SQL, outside normal production migrations.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { isolatedSupabaseEnvironment } from './isolated-supabase-env.mjs';
const { env } = isolatedSupabaseEnvironment();
const isolation = JSON.parse(
  execFileSync(process.execPath, ['scripts/inspect-demo-isolation.mjs'], {
    env,
    encoding: 'utf8',
  }),
);
const db = new pg.Client({ connectionString: env.E2E_ADMIN_DATABASE_URL });
const tables = [
  'users',
  'renter_profiles',
  'renter_preferences',
  'landlord_profiles',
  'properties',
  'evidence_items',
  'leri_connections',
  'leri_messages',
  'leri_property_photos',
];
const snapshot = async () => {
  const result = {};
  for (const table of tables)
    result[table] = (
      await db.query(
        `SELECT count(*)::int n,md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'')) hash FROM ${table} t`,
      )
    ).rows[0];
  return result;
};
try {
  await db.connect();
  const before = await snapshot();
  await db.query(readFileSync('demo/isolated-preview.sql', 'utf8'));
  const after = await snapshot();
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('Data changed unexpectedly');
  writeFileSync(
    'demo/preview-install.local',
    JSON.stringify({ isolation, before, after, unchanged: true }, null, 2) +
      '\n',
    { mode: 0o600 },
  );
  console.log(
    'Installed isolated read-only preview functions; all data snapshots unchanged.',
  );
} finally {
  await db.end();
}
