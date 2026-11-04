import { spawnSync } from 'node:child_process';
import { isolatedSupabaseEnvironment } from './isolated-supabase-env.mjs';
// No .env, linked project, db push, reset, or cleanup operations are used here.
const { env } = isolatedSupabaseEnvironment();
console.log(
  'Running real-auth E2E against isolated API 127.0.0.1:55321 and DB 127.0.0.1:55322 as app_user. Cleanup disabled.',
);
const result = spawnSync(
  process.execPath,
  [
    'node_modules/jest/bin/jest.js',
    '--config',
    './test/jest-e2e.json',
    '--runInBand',
    ...process.argv.slice(2),
  ],
  { env, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
