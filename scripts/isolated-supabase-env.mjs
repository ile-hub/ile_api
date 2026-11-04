import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function isolatedSupabaseEnvironment() {
  const workdir = process.env.LERI_SUPABASE_TEST_WORKDIR;
  if (
    !workdir ||
    !/^\/private\/tmp\/leri-supabase-phase[12]-/.test(resolve(workdir))
  )
    throw new Error(
      'Set LERI_SUPABASE_TEST_WORKDIR to the explicitly created disposable local stack',
    );
  if (existsSync(resolve(workdir, 'supabase/.temp/project-ref')))
    throw new Error('Refusing a linked project directory');
  const config = readFileSync(resolve(workdir, 'supabase/config.toml'), 'utf8');
  if (!/^project_id = "leri-phase[12]-validation-[a-z0-9-]+"$/m.test(config))
    throw new Error('Unexpected isolated project ID');
  const status = JSON.parse(
    execFileSync('supabase', ['status', '--workdir', workdir, '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  if (status.API_URL !== 'http://127.0.0.1:55321')
    throw new Error('Unexpected local API target');
  const db = new URL(status.DB_URL);
  if (
    db.hostname !== '127.0.0.1' ||
    db.port !== '55322' ||
    db.pathname !== '/postgres' ||
    db.search ||
    db.username !== 'postgres'
  )
    throw new Error('Unexpected local DB target');
  if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY)
    throw new Error('Local Supabase authentication keys missing');
  const appDb = new URL(db);
  appDb.username = 'app_user';
  appDb.password = 'app_user_local_dev';
  return {
    workdir,
    env: {
      ...process.env,
      E2E_ISOLATED_LOCAL: '1',
      DATABASE_URL: appDb.toString(),
      E2E_ADMIN_DATABASE_URL: db.toString(),
      SUPABASE_URL: status.API_URL,
      SUPABASE_ANON_KEY: status.ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      SUPABASE_JWT_SECRET: status.JWT_SECRET ?? '',
      REQUIRE_VERIFICATION: 'false',
    },
  };
}
