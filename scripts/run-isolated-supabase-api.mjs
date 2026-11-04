import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { isolatedSupabaseEnvironment } from './isolated-supabase-env.mjs';

// Only inspect the already running disposable stack; never migrate or reset it.
const { env } = isolatedSupabaseEnvironment();
const hosts = ['localhost', '127.0.0.1', '[::1]'];
for (const addresses of Object.values(networkInterfaces())) {
  for (const address of addresses ?? []) {
    if (address.family === 'IPv4' && !address.internal) hosts.push(address.address);
  }
}
env.CORS_ORIGINS ??= hosts
  .flatMap((host) => [8081, 19006].map((port) => `http://${host}:${port}`))
  .join(',');
env.HOST ??= '::';
env.PORT ??= '3000';
// The API uses the restricted database role and public Auth verification.
delete env.E2E_ADMIN_DATABASE_URL;
delete env.SUPABASE_SERVICE_ROLE_KEY;
delete env.SUPABASE_JWT_SECRET;
console.log(`Starting isolated API on port ${env.PORT}; Supabase 127.0.0.1:55321, PostgreSQL 127.0.0.1:55322.`);
const child = spawn(process.execPath, ['node_modules/@nestjs/cli/bin/nest.js', 'start', '--watch'], {
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => { throw error; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
