import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

// These are real end-to-end tests: they need the local Supabase stack
// running (`npm run db:start`) with migrations applied, and the same .env
// the app uses. Users are created through Supabase Auth itself, so every
// request goes through the real JWKS-verified session token path and the
// real handle_new_user signup trigger -- nothing is hand-minted.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set (see .env.example) to run e2e tests`);
  }
  return value;
}

export interface TestUser {
  id: string;
  email: string;
  displayName: string;
  token: string;
}

// Unique per call, so tests never collide with each other or with rows
// left by earlier runs.
export async function createUser(
  role: 'renter' | 'landlord',
  label: string,
): Promise<TestUser> {
  const supabaseUrl = env('SUPABASE_URL');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const suffix = randomUUID().slice(0, 8);
  const email = `e2e-${role}-${suffix}@example.test`;
  const password = `pw-${randomUUID()}`;
  const displayName = `${label} ${suffix}`;

  const created = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { role, display_name: displayName },
    }),
  });
  if (!created.ok) {
    throw new Error(
      `createUser failed: ${created.status} ${await created.text()}`,
    );
  }
  const { id } = (await created.json()) as { id: string };

  const session = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        apikey: env('SUPABASE_ANON_KEY'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    },
  );
  if (!session.ok) {
    throw new Error(
      `sign-in failed: ${session.status} ${await session.text()}`,
    );
  }
  const { access_token } = (await session.json()) as { access_token: string };
  return { id, email, displayName, token: access_token };
}

export async function createApp(): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  await app.init();
  return app;
}

// Thin supertest wrapper: api(app, user).get('/path')
export function api(app: INestApplication<App>, user: TestUser) {
  const server = app.getHttpServer();
  const auth = (r: request.Test) =>
    r.set('Authorization', `Bearer ${user.token}`);
  return {
    get: (path: string) => auth(request(server).get(path)),
    post: (path: string, body?: object) =>
      auth(request(server).post(path)).send(body ?? {}),
    patch: (path: string, body: object) =>
      auth(request(server).patch(path)).send(body),
  };
}

// Direct database access as app_user (the app's own non-BYPASSRLS role)
// with app.current_user_id set exactly as RlsTransactionInterceptor sets
// it. Used to prove RLS/trigger rules hold for ANY query, not just the
// routes that exist. Always rolls back, so nothing persists.
export class AppUserDb {
  private readonly pool = new Pool({ connectionString: env('DATABASE_URL') });

  async as<T>(
    userId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [
        userId,
      ]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  // Runs one statement as `userId` and returns the Postgres error code it
  // failed with, or 'ok:<rowCount>' if it succeeded.
  async outcome(
    userId: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<string> {
    return this.as(userId, async (client) => {
      try {
        const result = await client.query(sql, params);
        return `ok:${result.rowCount}`;
      } catch (err) {
        return (err as { code?: string }).code ?? 'error';
      }
    });
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

export const VALID_PROPERTY = {
  title: 'Bright two-bed flat',
  description: 'Close to the station.',
  addressLine1: '12 Example Street',
  city: 'Edinburgh',
  postcode: 'EH1 1AA',
  bedrooms: 2,
  rentAmount: 1250.5,
  propertyRules: ['no_smoking'],
};
