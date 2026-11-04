// Fail closed before any test hook/user creation when using the isolated runner.
export function assertIsolatedTarget(): void {
  if (process.env.E2E_ISOLATED_LOCAL !== '1') return;
  for (const key of ['DATABASE_URL', 'E2E_ADMIN_DATABASE_URL']) {
    const value = process.env[key];
    if (!value) throw new Error(`${key} is required by isolated E2E tests`);
    const url = new URL(value);
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '55322' ||
      url.pathname !== '/postgres' ||
      url.search
    ) {
      throw new Error(
        `Refusing ${key}: isolated E2E requires 127.0.0.1:55322/postgres without connection overrides`,
      );
    }
    if (url.username !== (key === 'DATABASE_URL' ? 'app_user' : 'postgres'))
      throw new Error(`Unexpected database role in ${key}`);
  }
  if (process.env.SUPABASE_URL !== 'http://127.0.0.1:55321')
    throw new Error('Refusing a non-isolated Supabase Auth target');
}
