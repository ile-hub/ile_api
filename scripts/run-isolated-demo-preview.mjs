import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolatedSupabaseEnvironment } from './isolated-supabase-env.mjs';
const { env } = isolatedSupabaseEnvironment();
execFileSync(process.execPath, ['scripts/inspect-demo-isolation.mjs'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
env.NODE_ENV ??= 'development';
Object.assign(env, {
  LERI_DEMO_PREVIEW: 'true',
  LERI_DEMO_PREVIEW_ALLOWLIST: resolve('demo/preview-allowlist.json'),
  LERI_DEMO_PREVIEW_STORAGE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
  HOST: '127.0.0.1',
  PORT: process.env.PORT ?? '3109',
});
delete env.SUPABASE_SERVICE_ROLE_KEY;
delete env.E2E_ADMIN_DATABASE_URL;
delete env.SUPABASE_JWT_SECRET;
const child = spawn(process.execPath, ['dist/main.js'], {
  env,
  stdio: 'inherit',
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
