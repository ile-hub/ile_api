import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import request from 'supertest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { api, createApp, TestUser, AppUserDb } from './helpers';
const manifest = JSON.parse(
  readFileSync(resolve('demo/preview-allowlist.json'), 'utf8'),
) as {
  accounts: Record<string, string>;
  properties: Record<string, string>;
};
const credentials = JSON.parse(
  readFileSync(resolve('demo/showcase.credentials.local'), 'utf8'),
) as {
  people: Record<string, { email: string; password: string; id: string }>;
};
const ids = Object.keys(manifest.properties);
describe('Allowlisted isolated demo preview with real Supabase Auth and RLS', () => {
  let app: INestApplication<App>,
    normal: INestApplication<App>,
    db: Pool,
    rls: AppUserDb;
  const users: Record<string, TestUser> = {};
  let before: unknown;
  const evidence: Record<string, unknown> = {};
  const snapshot = async () => {
    const result: Record<string, unknown> = {};
    for (const table of [
      'users',
      'renter_profiles',
      'landlord_profiles',
      'properties',
      'evidence_items',
      'leri_connections',
      'leri_messages',
      'leri_property_photos',
    ])
      result[table] = (
        await db.query(
          `SELECT count(*)::int n,md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'')) hash FROM ${table} t`,
        )
      ).rows[0];
    return result;
  };
  beforeAll(async () => {
    db = new Pool({ connectionString: process.env.E2E_ADMIN_DATABASE_URL });
    rls = new AppUserDb();
    before = await snapshot();
    const counts = await db.query<{
      users: number;
      properties: number;
      connections: number;
      messages: number;
      photos: number;
    }>(
      'SELECT (SELECT count(*)::int FROM users) users,(SELECT count(*)::int FROM properties) properties,(SELECT count(*)::int FROM leri_connections) connections,(SELECT count(*)::int FROM leri_messages) messages,(SELECT count(*)::int FROM leri_property_photos WHERE removed_at IS NULL) photos',
    );
    expect(counts.rows[0]).toEqual({
      users: 6,
      properties: 7,
      connections: 9,
      messages: 6,
      photos: 7,
    });
    delete process.env.LERI_DEMO_PREVIEW;
    normal = await createApp();
    process.env.LERI_DEMO_PREVIEW = 'true';
    process.env.LERI_DEMO_PREVIEW_ALLOWLIST = resolve(
      'demo/preview-allowlist.json',
    );
    process.env.LERI_DEMO_PREVIEW_STORAGE_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY;
    app = await createApp();
    for (const [key, c] of Object.entries(credentials.people)) {
      const res = await fetch(
        process.env.SUPABASE_URL + '/auth/v1/token?grant_type=password',
        {
          method: 'POST',
          headers: {
            apikey: process.env.SUPABASE_ANON_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ email: c.email, password: c.password }),
        },
      );
      if (!res.ok) throw new Error('Demo sign-in failed');
      const session = (await res.json()) as { access_token: string };
      users[key] = {
        id: c.id,
        email: c.email,
        displayName: key,
        token: session.access_token,
      };
    }
  }, 60000);
  afterAll(async () => {
    if (before) {
      const after = await snapshot();
      expect(after).toEqual(before);
      evidence.dataUnchanged = true;
      evidence.before = before;
      evidence.after = after;
    }
    writeFileSync(
      resolve('demo/preview-verification.local'),
      JSON.stringify(evidence, null, 2) + '\n',
      { mode: 0o600 },
    );
    await app?.close();
    await normal?.close();
    await rls?.end();
    await db?.end();
    delete process.env.LERI_DEMO_PREVIEW;
    delete process.env.LERI_DEMO_PREVIEW_ALLOWLIST;
    delete process.env.LERI_DEMO_PREVIEW_STORAGE_KEY;
  });
  async function discovery(
    application: INestApplication<App>,
    key: string,
    mode = 'all',
  ) {
    const items: {
      profile: {
        id: string;
        kind: string;
        properties?: { id: string; status: string; presentation?: object }[];
      };
      reasons: string[];
    }[] = [];
    let after: string | null = null;
    do {
      const res = await api(application, users[key])
        .get(
          `/discovery?mode=${mode}&limit=20${after ? '&after=' + after : ''}`,
        )
        .expect(200);
      items.push(...(res.body.items as typeof items));
      after = res.body.nextCursor as string | null;
    } while (after);
    return items;
  }
  it('shows exactly seven labelled drafts under the correct landlords, with safe details', async () => {
    const seen: string[] = [];
    for (const key of ['amina', 'david', 'sarah']) {
      const res = await api(app, users.jamie)
        .get(`/profiles/${manifest.accounts[key]}`)
        .expect(200);
      const list = await api(app, users.jamie)
        .get(`/landlords/${manifest.accounts[key]}/properties`)
        .expect(200);
      const expected = ids
        .filter((id) => manifest.properties[id] === key)
        .sort();
      expect((list.body as { id: string }[]).map((p) => p.id).sort()).toEqual(
        expected,
      );
      expect(
        (res.body.properties as { id: string }[]).map((p) => p.id).sort(),
      ).toEqual(expected);
      for (const id of expected) {
        const detail = await api(app, users.jamie)
          .get(`/landlords/${manifest.accounts[key]}/properties/${id}`)
          .expect(200);
        expect(detail.body.status).toBe('draft');
        expect(detail.body.listingStatus).toBe('demo_preview');
        expect(detail.body.publishedAt).toBeNull();
        expect(detail.body.presentation.mode).toBe('synthetic_demo_preview');
        for (const field of [
          'addressLine1',
          'postcode',
          'privateReference',
          'registrationNumbers',
          'registrationDetails',
          'hmoLicenceDetails',
          'object_path',
          'payload',
          'explanation',
        ])
          expect(JSON.stringify(detail.body)).not.toContain('"' + field + '"');
        expect(detail.body.details.epcRating).toBeNull();
        expect(detail.body.details.hmoLicenceStatus).toBe('unknown');
        seen.push(id);
      }
    }
    expect(seen.sort()).toEqual([...ids].sort());
  });
  it('denies previews by default, anonymously, for wrong owner paths and for nonallowlisted drafts', async () => {
    await request(app.getHttpServer())
      .get('/properties/' + ids[0])
      .expect(401);
    await api(normal, users.jamie)
      .get('/properties/' + ids[0])
      .expect(404);
    await api(app, users.jamie)
      .get(`/landlords/${manifest.accounts.sarah}/properties/${ids[0]}`)
      .expect(404);
    // The cleaned dataset has no outside drafts/users. Probe an unknown UUID,
    // and the actual SQL authorization with a non-allowlisted caller UUID.
    const nonAllowlisted = randomUUID();
    expect(ids).not.toContain(nonAllowlisted);
    await api(app, users.jamie)
      .get('/properties/' + nonAllowlisted)
      .expect(404);
    const allDrafts = await db.query<{ id: string }>(
      "SELECT id FROM properties WHERE status='draft'",
    );
    expect(allDrafts.rows.map((p) => p.id).sort()).toEqual([...ids].sort());
    const outsider = { id: randomUUID() };
    const rows = await rls.as(outsider.id, async (c) => {
      await c.query(
        "SELECT set_config('app.leri_demo_preview','leri-phase2-validation-20261014-final',true)",
      );
      return c.query('SELECT * FROM leri_demo_preview_properties(NULL)');
    });
    expect(rows.rowCount).toBe(0);
    const denied = await fetch(
      process.env.SUPABASE_URL + '/rest/v1/rpc/leri_demo_preview_properties',
      {
        method: 'POST',
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${users.jamie.token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    );
    expect(denied.ok).toBe(false);
  });
  it('keeps the SQL preview gate transaction-local and disabled without application authorization', async () => {
    const rows = await rls.as(users.jamie.id, (c) =>
      c.query('SELECT * FROM leri_demo_preview_properties(NULL)'),
    );
    expect(rows.rowCount).toBe(0);
    await rls.as(users.jamie.id, async (c) => {
      await c.query(
        "SELECT set_config('app.leri_demo_preview','leri-phase2-validation-20261014-final',true)",
      );
      const published = await c.query('SELECT leri_public_property($1) AS p', [
        ids[0],
      ]);
      expect(published.rows[0].p).toBeNull();
      const raw = await c.query('SELECT id FROM properties WHERE id=$1', [
        ids[0],
      ]);
      expect(raw.rowCount).toBe(0);
    });
  });
  it('produces practical suggestions for both roles and leaves Explore IDs unchanged', async () => {
    const expected: Record<string, string[]> = {
      jamie: ['amina', 'david', 'sarah'],
      priya: ['amina'],
      lewis: ['amina', 'sarah'],
    };
    const result: Record<
      string,
      { explore: number; suggested: number; demo: string[] }
    > = {};
    for (const key of Object.keys(users)) {
      const all = await discovery(app, key),
        baseline = await discovery(normal, key),
        suggested = await discovery(app, key, 'suggested');
      expect(all.map((x) => x.profile.id)).toEqual(
        baseline.map((x) => x.profile.id),
      );
      expect(
        all.every(
          (x) =>
            x.profile.kind !==
            (['amina', 'david', 'sarah'].includes(key) ? 'landlord' : 'renter'),
        ),
      ).toBe(true);
      const demo = suggested.filter((x) =>
        Object.values(manifest.accounts).includes(x.profile.id),
      );
      if (expected[key])
        expect(demo.map((x) => x.profile.id).sort()).toEqual(
          expected[key].map((k) => manifest.accounts[k]).sort(),
        );
      for (const item of suggested) {
        expect(item.reasons.length).toBeGreaterThan(0);
        expect(JSON.stringify(item)).not.toMatch(
          /matchScore|riskScore|trustScore/,
        );
      }
      result[key] = {
        explore: all.length,
        suggested: suggested.length,
        demo: demo.map((x) => x.profile.id),
      };
    }
    evidence.discovery = result;
    console.log('DEMO_PREVIEW_DISCOVERY', JSON.stringify(result));
  });
  it('keeps draft status, publication validation, verification and existing conversations intact', async () => {
    const stored = (
      await db.query(
        'SELECT id,status,published_at FROM properties WHERE id=ANY($1::uuid[])',
        [ids],
      )
    ).rows;
    expect(stored).toHaveLength(7);
    expect(
      stored.every((p) => p.status === 'draft' && p.published_at === null),
    ).toBe(true);
    await api(app, users.amina)
      .post(`/properties/${ids[0]}/publish`)
      .expect(400);
    for (const user of Object.values(users)) {
      const own = await api(app, user).get('/me/profile/preview').expect(200);
      expect(own.body.verification.mode).toBe('demo');
      expect(own.body.verification.identityStatus).toBe('unverified');
      const list = await api(app, user).get('/connections').expect(200);
      expect(list.body.items).toHaveLength(3);
      for (const c of list.body.items) {
        if (c.status === 'accepted') {
          const messages = await api(app, user)
            .get(`/connections/${c.id}/messages`)
            .expect(200);
          expect(messages.body.items).toHaveLength(2);
        } else
          await api(app, user).get(`/connections/${c.id}/messages`).expect(409);
      }
    }
  });
  it('retrieves all seven existing illustrative photos without creating or editing records', async () => {
    let fetched = 0;
    for (const id of ids) {
      const owner = manifest.properties[id];
      const photos = await api(app, users[owner])
        .get(`/properties/${id}/photos`)
        .expect(200);
      const entries = photos.body as { id: string; caption: string }[];
      expect(entries).toHaveLength(1);
      const photoId = entries[0].id;
      expect(entries[0].caption).toMatch(/illustrative/i);
      const path = `/landlords/${manifest.accounts[owner]}/properties/${id}/photos/${photoId}/download`;
      const direct = await fetch(
        `${process.env.SUPABASE_URL}/storage/v1/object/authenticated/leri-property-photos-v2/${manifest.accounts[owner]}/property/${id}/${photoId}`,
        {
          headers: {
            apikey: process.env.SUPABASE_ANON_KEY!,
            Authorization: `Bearer ${users.jamie.token}`,
          },
        },
      );
      expect([400, 401, 403, 404]).toContain(direct.status);
      const signed = await api(app, users.jamie).get(path).expect(200);
      expect(signed.body.expiresIn).toBe(60);
      const image = await fetch(signed.body.url as string);
      expect(image.status).toBe(200);
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0);
      await api(normal, users.jamie).get(path).expect(404);
      await api(app, users.jamie)
        .get(path.replace(photoId, randomUUID()))
        .expect(404);
      fetched++;
    }
    evidence.existingPhotosRetrieved = fetched;
    expect(fetched).toBe(7);
  });
});
