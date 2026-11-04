import { existsSync } from 'node:fs';
import { assertIsolatedTarget } from './isolated-target';
import { purgeTestUsers } from './purge-test-users';

// Jest globalSetup and globalTeardown (see jest-e2e.json): removes every
// user the e2e suites create (helpers.ts gives them all an
// e2e-...@example.test address) plus everything they own -- once before
// the run, to clear leftovers from a run that crashed, and once after.
// Without this, every run leaves its users, properties and interests in
// the local database, and they show up in the app's renter feed.
export default async function cleanupE2eUsers(): Promise<void> {
  assertIsolatedTarget();
  if (process.env.E2E_ISOLATED_LOCAL === '1') {
    console.log(
      'Isolated E2E: retaining synthetic records; cleanup deletion is disabled.',
    );
    return;
  }
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const adminUrl = process.env.E2E_ADMIN_DATABASE_URL;
  if (!adminUrl) {
    console.warn(
      '\nE2E_ADMIN_DATABASE_URL is not set (see .env.example) -- e2e users are not being cleaned up.',
    );
    return;
  }
  await purgeTestUsers(adminUrl, 'e2e-%@example.test');
}
