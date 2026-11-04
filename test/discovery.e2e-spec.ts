import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  api,
  AppUserDb,
  createApp,
  createUser,
  TestUser,
  VALID_PROPERTY,
} from './helpers';

describe('People discovery using real Supabase authentication and RLS', () => {
  let app: INestApplication<App>, db: AppUserDb;
  let renter: TestUser, landlord: TestUser, hidden: TestUser, other: TestUser;
  beforeAll(async () => {
    app = await createApp();
    db = new AppUserDb();
    renter = await createUser('renter', 'Discovery renter');
    other = await createUser('renter', 'Other discovery renter');
    landlord = await createUser('landlord', 'Discovery landlord');
    hidden = await createUser('landlord', 'Hidden discovery landlord');
    await api(app, renter)
      .patch('/me/profile', {
        discoverable: true,
        preferredLocation: 'Edinburgh',
        budgetMax: 1500,
        personalStory: 'Synthetic story',
        currentLocation: 'PRIVATE LOCATION',
      })
      .expect(200);
    await api(app, other)
      .patch('/me/profile', { discoverable: true })
      .expect(200);
    await api(app, landlord)
      .patch('/me/profile', { discoverable: true })
      .expect(200);
    const property = await api(app, landlord)
      .post('/properties', VALID_PROPERTY)
      .expect(201);
    await api(app, landlord)
      .post(`/properties/${property.body.id}/publish`)
      .expect(200);
  });
  afterAll(async () => {
    await db?.end();
    await app?.close();
  });
  async function all(user: TestUser, mode = 'all') {
    const items: {
      profile: { id: string; kind: string; [key: string]: unknown };
      reasons: string[];
    }[] = [];
    let after: string | null = null;
    do {
      const result = await api(app, user)
        .get(
          `/discovery?mode=${mode}&limit=50${after ? '&after=' + after : ''}`,
        )
        .expect(200);
      items.push(...(result.body.items as typeof items));
      after = result.body.nextCursor as string | null;
    } while (after);
    return items;
  }
  it('requires authentication and rejects unsupported filters and malformed cursors', async () => {
    await request(app.getHttpServer()).get('/discovery').expect(401);
    await api(app, renter).get('/discovery?mode=risk').expect(400);
    await api(app, renter).get('/discovery?limit=1000').expect(400);
    await api(app, renter).get('/discovery?after=invalid').expect(400);
    await api(app, renter).get('/discovery?trustScore=1').expect(400);
  });
  it('explores only discoverable opposite-role profiles without private data', async () => {
    const rows = await all(renter);
    expect(rows.some((x) => x.profile.id === landlord.id)).toBe(true);
    expect(
      rows.some((x) => [hidden.id, renter.id, other.id].includes(x.profile.id)),
    ).toBe(false);
    expect(
      rows.every((x) => x.profile.kind === 'landlord' && !x.reasons.length),
    ).toBe(true);
    const reverse = await all(landlord);
    expect(reverse.some((x) => x.profile.id === renter.id)).toBe(true);
    const text = JSON.stringify(reverse);
    expect(text).not.toContain('PRIVATE LOCATION');
    expect(text).not.toContain('"email"');
  });
  it('suggests practical fit, keeps Explore independent and returns no numerical grades', async () => {
    const rows = await all(renter, 'suggested');
    const candidate = rows.find((x) => x.profile.id === landlord.id);
    expect(candidate?.reasons).toContain('Rent fits the stated budget');
    expect(candidate?.reasons).toContain('In your preferred area');
    expect(JSON.stringify(candidate)).not.toMatch(
      /trustScore|riskScore|matchScore/,
    );
    await api(app, renter).patch('/me/profile', { budgetMax: 100 }).expect(200);
    expect(
      (await all(renter, 'suggested')).some(
        (x) => x.profile.id === landlord.id,
      ),
    ).toBe(false);
    expect((await all(renter)).some((x) => x.profile.id === landlord.id)).toBe(
      true,
    );
    await api(app, renter)
      .patch('/me/profile', { budgetMax: 1500 })
      .expect(200);
  });
  it('pages without duplicates and rejects anonymous/direct authenticated Supabase execution', async () => {
    const first = await api(app, renter).get('/discovery?limit=1').expect(200);
    if (first.body.nextCursor) {
      const second = await api(app, renter)
        .get('/discovery?limit=1&after=' + first.body.nextCursor)
        .expect(200);
      expect(second.body.items[0]?.profile.id).not.toBe(
        first.body.items[0]?.profile.id,
      );
    }
    expect(
      await db.as(randomUUID(), (c) =>
        c.query('SELECT * FROM leri_discovery(NULL,20)'),
      ),
    ).toMatchObject({ rowCount: 0 });
    const response = await fetch(
      process.env.SUPABASE_URL + '/rest/v1/rpc/leri_discovery',
      {
        method: 'POST',
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${renter.token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    );
    expect(response.ok).toBe(false);
  });
});
