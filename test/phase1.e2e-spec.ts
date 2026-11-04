/** Phase 1 through real Supabase Auth/JWKS, Postgres/PostGIS and RLS. */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createApp, createUser, TestUser } from './helpers';
import { assertIsolatedTarget } from './isolated-target';

const legalRun = randomUUID();
const version1 = `e2e-${legalRun}-1`;
const version2 = `e2e-${legalRun}-2`;
const draftVersion = `e2e-${legalRun}-draft`;
describe('Phase 1 real Supabase authentication and database', () => {
  let admin: Pool;
  let pool: Pool;
  let app: INestApplication<App>;
  let renter: string, landlord: string, outsider: string;
  const evidence = randomUUID(),
    property = randomUUID();
  const users = new Map<string, TestUser>();
  const token = (id: string) => users.get(id)!.token;
  async function as<T>(id: string, fn: (db: PoolClient) => Promise<T>) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT set_config('app.current_user_id', $1, true)", [
        id,
      ]);
      return await fn(db);
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  }
  const get = (id: string, path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${token(id)}`);
  const patch = (id: string, body: object) =>
    request(app.getHttpServer())
      .patch('/me/profile')
      .set('Authorization', `Bearer ${token(id)}`)
      .send(body);
  const post = (id: string, path: string, body: object) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token(id)}`)
      .send(body);

  beforeAll(async () => {
    if (process.env.E2E_ISOLATED_LOCAL !== '1')
      throw new Error(
        'Phase 1 Supabase tests require the isolated runner; existing databases must not be used',
      );
    assertIsolatedTarget();
    admin = new Pool({ connectionString: process.env.E2E_ADMIN_DATABASE_URL });
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const role = (
      await pool.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolname: string;
      }>(
        'SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
      )
    ).rows[0];
    expect(role).toEqual({
      rolname: 'app_user',
      rolsuper: false,
      rolbypassrls: false,
    });
    const fixtures = await Promise.all([
      createUser('renter', 'Phase 1 renter'),
      createUser('landlord', 'Phase 1 landlord'),
      createUser('renter', 'Other renter'),
    ]);
    for (const user of fixtures) users.set(user.id, user);
    [renter, landlord, outsider] = fixtures.map((u) => u.id);
    await admin.query(
      "UPDATE renter_profiles SET bio='Original biography',date_of_birth='1990-01-01' WHERE user_id=$1",
      [renter],
    );
    await admin.query(
      `INSERT INTO evidence_items(id,renter_id,pillar,pathway_type,payload) VALUES($1,$2,'affordability','payslip','{"accountNumber":"private"}')`,
      [evidence, renter],
    );
    await admin.query(
      "INSERT INTO properties(id,landlord_id,address_line1,city,postcode,bedrooms,rent_amount) VALUES($1,$2,'PRIVATE ADDRESS','Edinburgh','EH1 1AA',2,900)",
      [property, landlord],
    );
    await admin.query("UPDATE properties SET status='published' WHERE id=$1", [
      property,
    ]);
    app = await createApp();
  });
  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (admin) await admin.end();
  });

  it('applies both migrations with real PostGIS and preserves pre-migration records', async () => {
    const marker = JSON.parse(
      readFileSync(
        resolve(
          process.env.LERI_SUPABASE_TEST_WORKDIR!,
          'migration-validation.json',
        ),
        'utf8',
      ),
    ) as {
      preserved: boolean;
      versions: string[];
      postgis: string;
      sentinel: { renter: string; evidence: string; property: string };
      before: unknown;
    };
    expect(marker.preserved).toBe(true);
    expect(marker.versions).toContain('20261014130000');
    expect(marker.versions).toContain('20261014131000');
    const row = await admin.query(
      `SELECT jsonb_build_object('renter', (SELECT jsonb_build_object('id',user_id,'bio',bio,'name',display_name) FROM renter_profiles WHERE user_id=$1), 'evidence', (SELECT to_jsonb(e) FROM evidence_items e WHERE id=$2), 'property', (SELECT to_jsonb(p) FROM properties p WHERE id=$3)) AS data`,
      [
        marker.sentinel.renter,
        marker.sentinel.evidence,
        marker.sentinel.property,
      ],
    );
    expect(row.rows[0].data).toEqual(marker.before);
    expect(
      (
        await admin.query(
          "SELECT extversion FROM pg_extension WHERE extname='postgis'",
        )
      ).rows[0].extversion,
    ).toBe(marker.postgis);
  });
  it('rejects invalid and tampered JWTs using the real authentication guard', async () => {
    await request(app.getHttpServer())
      .get('/me/profile')
      .set('Authorization', 'Bearer definitely-invalid')
      .expect(401);
    // A real session with a corrupted signature must also fail.
    const parts = token(renter).split('.');
    parts[2] = (parts[2][0] === 'a' ? 'b' : 'a') + parts[2].slice(1);
    await request(app.getHttpServer())
      .get('/me/profile')
      .set('Authorization', `Bearer ${parts.join('.')}`)
      .expect(401);
  });
  it('preserves real-Supabase synthetic profile, evidence and property fixtures', async () => {
    expect((await get(renter, '/me/profile').expect(200)).body.bio).toBe(
      'Original biography',
    );
    expect(
      (
        await admin.query('SELECT payload FROM evidence_items WHERE id=$1', [
          evidence,
        ])
      ).rows[0].payload,
    ).toEqual({ accountNumber: 'private' });
    expect(
      (
        await admin.query('SELECT address_line1 FROM properties WHERE id=$1', [
          property,
        ])
      ).rows[0].address_line1,
    ).toBe('PRIVATE ADDRESS');
    await get(renter, '/me').expect(200);
  });
  it('requires authentication on all profile/privacy and catalogue routes', async () => {
    for (const path of [
      '/me/profile',
      '/me/profile/preview',
      `/profiles/${renter}`,
      '/me/privacy',
      '/evidence/catalogue',
    ])
      await request(app.getHttpServer()).get(path).expect(401);
    await request(app.getHttpServer())
      .patch('/me/profile')
      .send({ bio: 'x' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/me/privacy/terms-acceptance')
      .send({ termsVersion: version1, accepted: true })
      .expect(401);
  });
  it('starts with cross-user profile visibility disabled', async () => {
    await get(landlord, `/profiles/${renter}`).expect(404);
  });
  it('edits renter story, profile and preference fields atomically', async () => {
    const { body } = await patch(renter, {
      displayName: 'Updated renter',
      bio: 'Public bio',
      personalStory: 'I take care of my home.',
      currentLocation: 'Private current place',
      preferredLocation: 'Edinburgh',
      budgetMin: 700,
      budgetMax: 1100,
      targetMoveDate: '2026-11-01',
      tenancyLengthMonths: 12,
      householdSize: 2,
      householdType: 'couple',
      householdPreferences: ['smoke_free'],
      discoverable: true,
    }).expect(200);
    expect(body).toMatchObject({
      id: renter,
      personalStory: 'I take care of my home.',
      budgetMin: 700,
      budgetMax: 1100,
      currentLocation: 'Private current place',
      discoverable: true,
    });
  });
  it('rejects an inconsistent partial budget and keeps prior data', async () => {
    await patch(renter, { bio: 'Should roll back', budgetMin: 1200 }).expect(
      400,
    );
    expect((await get(renter, '/me/profile')).body.bio).toBe('Public bio');
  });
  it('rejects role-inappropriate fields, malformed IDs and self-verification', async () => {
    await patch(renter, { landlordType: 'agent' }).expect(400);
    await patch(landlord, { personalStory: 'renter field' }).expect(400);
    await patch(landlord, { identityStatus: 'verified' }).expect(400);
    await patch(landlord, { verificationStatus: 'verified' }).expect(400);
    await patch(renter, { isDemo: true }).expect(400);
    await get(landlord, '/profiles/not-a-uuid').expect(400);
  });
  it('edits landlord prompts and treats submitted registration as pending', async () => {
    const { body } = await patch(landlord, {
      bio: 'Public landlord bio',
      landlordType: 'individual',
      lettingExperienceYears: 3,
      numberOfProperties: 2,
      locationsCovered: ['Edinburgh'],
      tenantExpectations: 'Prompt repairs.',
      tenancySuccess: 'Clear communication.',
      lettingApproach: 'Responsive',
      communicationStyle: 'Email',
      registrationNumbers: ['DEMO-123', 'DEMO-456'],
      registrationDetails: 'Private registration details',
      discoverable: true,
    }).expect(200);
    expect(body.registrationNumbers).toEqual(['DEMO-123', 'DEMO-456']);
    expect(body.verification).toEqual({
      identityStatus: 'unverified',
      registrationStatus: 'pending',
      photoStatus: 'unverified',
      mode: 'real',
    });
  });
  it('returns identical safe renter public/preview projections without sensitive data', async () => {
    const visible = (await get(landlord, `/profiles/${renter}`).expect(200))
      .body;
    const preview = (await get(renter, '/me/profile/preview').expect(200)).body;
    expect(visible).toEqual(preview);
    expect(visible.personalStory).toBe('I take care of my home.');
    for (const field of [
      'currentLocation',
      'dateOfBirth',
      'date_of_birth',
      'email',
      'phone',
      'institutionId',
      'payload',
      'documents',
      'identityProvider',
      'identityCheckReference',
      'discoverable',
    ])
      expect(visible).not.toHaveProperty(field);
    expect(JSON.stringify(visible)).not.toContain('private');
  });
  it('hides landlord registration details and provider references from public profiles', async () => {
    const { body } = await get(renter, `/profiles/${landlord}`).expect(200);
    expect(body.tenantExpectations).toBe('Prompt repairs.');
    expect(body).not.toHaveProperty('registrationNumbers');
    expect(body).not.toHaveProperty('registrationDetails');
    expect(JSON.stringify(body)).not.toContain('DEMO-123');
  });
  it('hardens the existing landlord response by excluding full addresses', async () => {
    const { body } = await get(renter, `/landlords/${landlord}`).expect(200);
    expect(body.properties[0]).toEqual({
      id: property,
      city: 'Edinburgh',
      bedrooms: 2,
      rentAmount: 900,
    });
  });
  it('hides same-role profiles and unknown users', async () => {
    await get(outsider, `/profiles/${renter}`).expect(404);
    await get(landlord, `/profiles/${randomUUID()}`).expect(404);
  });
  it('enforces profile and preference ownership at the database', async () => {
    await as(outsider, async (db) => {
      expect(
        (
          await db.query('SELECT * FROM renter_profiles WHERE user_id=$1', [
            renter,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await db.query('UPDATE renter_profiles SET bio=$1 WHERE user_id=$2', [
            'hacked',
            renter,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await db.query(
            'SELECT * FROM renter_preferences WHERE renter_id=$1',
            [renter],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await db.query(
            'UPDATE renter_preferences SET budget_max=1 WHERE renter_id=$1',
            [renter],
          )
        ).rowCount,
      ).toBe(0);
    });
  });
  it('denies database attempts to forge protected verification fields', async () => {
    for (const sql of [
      "UPDATE landlord_profiles SET verification_status='verified' WHERE user_id=$1",
      "UPDATE landlord_profiles SET identity_status='verified' WHERE user_id=$1",
      'UPDATE landlord_profiles SET is_demo=true WHERE user_id=$1',
    ]) {
      await expect(
        as(landlord, (db) => db.query(sql, [landlord])),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      admin.query(
        "UPDATE landlord_profiles SET identity_status='verified' WHERE user_id=$1",
        [landlord],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('invalidates verified registration/photo results when their inputs change', async () => {
    await admin.query(
      `UPDATE landlord_profiles SET registration_verification_status='verified', registration_check_reference='real-check', registration_verified_at=now(), photo_url='https://example.com/a.jpg' WHERE user_id=$1`,
      [landlord],
    );
    await admin.query(
      `UPDATE landlord_profiles SET photo_verification_status='verified', photo_verified_at=now() WHERE user_id=$1`,
      [landlord],
    );
    const { body } = await patch(landlord, {
      registrationNumbers: ['DEMO-NEW'],
      photoUrl: 'https://example.com/b.jpg',
    }).expect(200);
    expect(body.verification.photoStatus).toBe('unverified');
    expect(body.verification.registrationStatus).toBe('pending');
  });
  it('handles the existing legal publication state and defaults optional consents to false', async () => {
    const documents = await request(app.getHttpServer()).get(
      '/legal/documents',
    );
    expect([200, 503]).toContain(documents.status);
    if (documents.status === 200) {
      expect(documents.body.terms.version).toBeTruthy();
      expect(documents.body.privacyNotice.version).toBeTruthy();
    }
    const { body } = await get(renter, '/me/privacy').expect(200);
    expect(body.termsAcceptances).toEqual([]);
    expect(
      (body.consents as { granted: boolean }[]).every(
        (c: { granted: boolean }) => c.granted === false,
      ),
    ).toBe(true);
  });
  it('serves published documents only and accepts terms without optional consent', async () => {
    await admin.query(
      `INSERT INTO leri_legal_documents (kind,version,title,content,published_at) VALUES ('terms',$1,'Demo terms','Synthetic test terms',now()),('privacy_notice',$1,'Demo privacy','Synthetic test notice',now()),('terms',$2,'Draft','Hidden draft',NULL)`,
      [version1, draftVersion],
    );
    const { body: docs } = await request(app.getHttpServer())
      .get('/legal/documents')
      .expect(200);
    expect(docs.terms.version).toBe(version1);
    expect(docs.terms.demoOnly).toBe(true);
    const first = await post(renter, '/me/privacy/terms-acceptance', {
      termsVersion: version1,
      accepted: true,
    }).expect(200);
    const second = await post(renter, '/me/privacy/terms-acceptance', {
      termsVersion: version1,
      accepted: true,
    }).expect(200);
    expect(first.body).toEqual(second.body);
    await post(renter, '/me/privacy/notice-acknowledgement', {
      privacyNoticeVersion: version1,
      acknowledged: true,
    }).expect(200);
    const { body } = await get(renter, '/me/privacy').expect(200);
    expect(body.termsAcceptances).toHaveLength(1);
    expect(body.privacyAcknowledgements).toHaveLength(1);
    expect(
      (body.consents as { granted: boolean }[]).every(
        (c: { granted: boolean }) => !c.granted,
      ),
    ).toBe(true);
  });
  it('records optional consent grant/withdrawal and isolates privacy records', async () => {
    for (const granted of [true, false]) {
      await request(app.getHttpServer())
        .put('/me/privacy/consents')
        .set('Authorization', `Bearer ${token(renter)}`)
        .send({
          purpose: 'user_research',
          granted,
          privacyNoticeVersion: version1,
        })
        .expect(200);
    }
    const { body } = await get(renter, '/me/privacy');
    expect(
      (body.consents as { purpose: string; granted: boolean }[]).find(
        (c: { purpose: string }) => c.purpose === 'user_research',
      )?.granted,
    ).toBe(false);
    expect(
      (
        await admin.query(
          'SELECT * FROM leri_consent_events WHERE user_id=$1',
          [renter],
        )
      ).rowCount,
    ).toBe(2);
    expect((await get(outsider, '/me/privacy')).body.termsAcceptances).toEqual(
      [],
    );
    await as(outsider, async (db) => {
      expect(
        (
          await db.query('SELECT * FROM leri_consent_events WHERE user_id=$1', [
            renter,
          ])
        ).rowCount,
      ).toBe(0);
    });
  });
  it('rejects stale versions, false acceptance and unknown consent purposes', async () => {
    await post(renter, '/me/privacy/terms-acceptance', {
      termsVersion: 'old',
      accepted: true,
    }).expect(409);
    await post(renter, '/me/privacy/terms-acceptance', {
      termsVersion: version1,
      accepted: false,
    }).expect(400);
    await request(app.getHttpServer())
      .put('/me/privacy/consents')
      .set('Authorization', `Bearer ${token(renter)}`)
      .send({
        purpose: 'anything',
        granted: true,
        privacyNoticeVersion: version1,
      })
      .expect(400);
  });
  it('makes privacy evidence append-only and prevents backdated/cross-user acceptance', async () => {
    await expect(
      as(renter, (db) =>
        db.query('UPDATE leri_consent_events SET granted=true'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      as(renter, (db) =>
        db.query(
          `INSERT INTO leri_terms_acceptances (user_id,document_id,accepted_at) SELECT $1,id,'2020-01-01' FROM leri_legal_documents WHERE kind='terms' AND version=$2`,
          [renter, version1],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      as(outsider, (db) =>
        db.query(
          `INSERT INTO leri_terms_acceptances (user_id,document_id) SELECT $1,id FROM leri_legal_documents WHERE kind='terms' AND version=$2`,
          [renter, version1],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      admin.query(
        `UPDATE leri_legal_documents SET content='Changed' WHERE kind='terms' AND version=$1`,
        [version1],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('returns all 54 configurable evidence choices without making them mandatory', async () => {
    const { body } = await get(renter, '/evidence/catalogue').expect(200);
    expect(body).toHaveLength(54);
    for (const [pillar, count] of [
      ['affordability', 16],
      ['reliability', 13],
      ['community', 14],
      ['stability', 11],
    ] as const)
      expect(
        (body as { pillar: string }[]).filter(
          (x: { pillar: string }) => x.pillar === pillar,
        ),
      ).toHaveLength(count);
    expect(
      (
        await admin.query('SELECT * FROM evidence_items WHERE id=$1', [
          evidence,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('keeps acceptance history when a new legal version is published', async () => {
    await admin.query(
      "INSERT INTO leri_legal_documents(kind,version,title,content,published_at) VALUES('terms',$1,'Updated synthetic terms','Updated synthetic demo-only terms',now())",
      [version2],
    );
    const documents = await request(app.getHttpServer())
      .get('/legal/documents')
      .expect(200);
    expect(documents.body.terms.version).toBe(version2);
    await post(renter, '/me/privacy/terms-acceptance', {
      termsVersion: version1,
      accepted: true,
    }).expect(409);
    await post(renter, '/me/privacy/terms-acceptance', {
      termsVersion: version2,
      accepted: true,
    }).expect(200);
    const state = await get(renter, '/me/privacy').expect(200);
    expect(
      (state.body.termsAcceptances as { version: string }[]).map(
        (a) => a.version,
      ),
    ).toEqual([version2, version1]);
  });
  it('enforces profile and legal document constraints in PostgreSQL', async () => {
    await expect(
      as(renter, (db) =>
        db.query(
          'UPDATE renter_profiles SET household_size=0 WHERE user_id=$1',
          [renter],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      as(landlord, (db) =>
        db.query(
          "UPDATE landlord_profiles SET landlord_type='unrecognised' WHERE user_id=$1",
          [landlord],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      as(renter, (db) =>
        db.query(
          "UPDATE renter_profiles SET photo_verification_status='verified' WHERE user_id=$1",
          [renter],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      as(renter, (db) =>
        db.query(
          "INSERT INTO leri_terms_acceptances(user_id,document_id) SELECT $1,id FROM leri_legal_documents WHERE kind='privacy_notice' AND version=$2",
          [renter, version1],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      as(renter, (db) =>
        db.query(
          "INSERT INTO renter_profiles(user_id,display_name,identity_status) VALUES($1,'Forged','verified')",
          [renter],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('hides an opted-out profile while retaining owner preview and stored data', async () => {
    await patch(renter, { discoverable: false }).expect(200);
    await get(landlord, `/profiles/${renter}`).expect(404);
    expect(
      (await get(renter, '/me/profile/preview').expect(200)).body.personalStory,
    ).toBe('I take care of my home.');
    await patch(renter, { discoverable: true }).expect(200);
  });
  it('does not expose sensitive base tables through the Supabase Data API', async () => {
    for (const table of [
      'users',
      'renter_profiles',
      'landlord_profiles',
      'evidence_items',
      'leri_terms_acceptances',
      'leri_privacy_acknowledgements',
      'leri_consent_events',
    ]) {
      const response = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/${table}?select=*`,
        {
          headers: {
            apikey: process.env.SUPABASE_ANON_KEY!,
            Authorization: `Bearer ${token(outsider)}`,
          },
        },
      );
      if (response.status === 200) expect(await response.json()).toEqual([]);
      else expect([401, 403, 404]).toContain(response.status);
    }
  });
  it('protects private Storage objects and signed URLs from other users and anonymous clients', async () => {
    const base = process.env.SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    };
    const bucket = `phase1-private-${randomUUID()}`;
    const created = await fetch(`${base}/storage/v1/bucket`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: bucket, name: bucket, public: false }),
    });
    expect(created.status).toBe(200);
    const uploaded = await fetch(
      `${base}/storage/v1/object/${bucket}/${renter}/dummy.txt`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'text/plain' },
        body: 'Synthetic private demo document',
      },
    );
    expect(uploaded.status).toBe(200);
    for (const bearer of [token(outsider), process.env.SUPABASE_ANON_KEY!]) {
      const userHeaders = {
        apikey: process.env.SUPABASE_ANON_KEY!,
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      };
      const downloaded = await fetch(
        `${base}/storage/v1/object/${bucket}/${renter}/dummy.txt`,
        { headers: userHeaders },
      );
      expect([400, 401, 403, 404]).toContain(downloaded.status);
      const signed = await fetch(
        `${base}/storage/v1/object/sign/${bucket}/${renter}/dummy.txt`,
        {
          method: 'POST',
          headers: userHeaders,
          body: JSON.stringify({ expiresIn: 60 }),
        },
      );
      expect([400, 401, 403, 404]).toContain(signed.status);
    }
    const publicDownload = await fetch(
      `${base}/storage/v1/object/public/${bucket}/${renter}/dummy.txt`,
    );
    expect([400, 401, 403, 404]).toContain(publicDownload.status);
    expect(
      (
        await admin.query(
          "SELECT relrowsecurity FROM pg_class WHERE oid='storage.objects'::regclass",
        )
      ).rows[0].relrowsecurity,
    ).toBe(true);
  });
});
