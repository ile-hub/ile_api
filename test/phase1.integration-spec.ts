/**
 * Opt-in integration tests against a NEW disposable PostgreSQL database only.
 * Never reads .env, never uses the existing E2E cleanup, never deletes user data.
 * PostGIS alone is omitted from the historical bootstrap because these tests
 * exercise profiles/privacy, not geography. All other migrations run verbatim.
 */
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { CommonModule } from '../src/common/common.module';
import { DatabaseModule, PG_POOL } from '../src/database/database.module';
import { EvidenceModule } from '../src/evidence/evidence.module';
import { LandlordsModule } from '../src/landlords/landlords.module';
import { MeModule } from '../src/me/me.module';
import { PrivacyModule } from '../src/privacy/privacy.module';
import { ProfilesModule } from '../src/profiles/profiles.module';
import { ValidationPipe } from '@nestjs/common';

const connectionString = process.env.LERI_PHASE1_TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'Set LERI_PHASE1_TEST_DATABASE_URL to a fresh database in the isolated temporary test cluster; .env is never used.',
  );
}
describe('Phase 1 isolated database and HTTP integration', () => {
  let admin: Pool;
  let pool: Pool;
  let app: INestApplication<App>;
  const renter = randomUUID(),
    landlord = randomUUID(),
    outsider = randomUUID();
  const evidence = randomUUID(),
    property = randomUUID();
  const identities = new Set<string>([renter, landlord, outsider]);
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
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${id}`);
  const patch = (id: string, body: object) =>
    request(app.getHttpServer())
      .patch('/me/profile')
      .set('Authorization', `Bearer ${id}`)
      .send(body);
  const post = (id: string, path: string, body: object) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${id}`)
      .send(body);

  beforeAll(async () => {
    const url = new URL(connectionString);
    if (
      url.searchParams.get('host') !== '/private/tmp' ||
      url.searchParams.get('port') !== '55439' ||
      !/^\/leri_phase1_test\d*$/.test(url.pathname)
    ) {
      throw new Error(
        'Refusing a database outside the dedicated temporary Phase 1 cluster',
      );
    }
    admin = new Pool({ connectionString });
    if (
      (await admin.query("SELECT to_regclass('public.users') AS existing"))
        .rows[0].existing
    ) {
      throw new Error(
        'Use a fresh empty test database; existing schemas are never reset',
      );
    }
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$;
      CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb);`);
    const migrationDir = resolve(__dirname, '../supabase/migrations');
    const files = readdirSync(migrationDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files.filter((f) => f < '20261014130000')) {
      let sql = readFileSync(resolve(migrationDir, file), 'utf8');
      if (file.endsWith('_init.sql')) {
        sql = sql.replace(
          /^CREATE EXTENSION IF NOT EXISTS postgis;.*$/m,
          '-- PostGIS omitted in isolated profile tests.',
        );
        sql = sql.replace(/^\s*location\s+geography\(Point, 4326\),.*$/m, '');
      }
      await admin.query(sql);
    }
    for (const [id, role, name] of [
      [renter, 'renter', 'Renter'],
      [landlord, 'landlord', 'Landlord'],
      [outsider, 'renter', 'Other renter'],
    ]) {
      await admin.query('INSERT INTO auth.users VALUES ($1, $2, $3)', [
        id,
        `${id}@example.test`,
        JSON.stringify({ role, display_name: name }),
      ]);
    }
    await admin.query(
      `UPDATE renter_profiles SET bio='Original biography', date_of_birth='1990-01-01' WHERE user_id=$1`,
      [renter],
    );
    await admin.query(
      `INSERT INTO evidence_items (id,renter_id,pillar,pathway_type,payload) VALUES ($1,$2,'affordability','payslip','{"accountNumber":"private"}')`,
      [evidence, renter],
    );
    await admin.query(
      `INSERT INTO properties (id,landlord_id,address_line1,city,postcode,bedrooms,rent_amount) VALUES ($1,$2,'PRIVATE ADDRESS','Edinburgh','EH1 1AA',2,900)`,
      [property, landlord],
    );
    await admin.query("UPDATE properties SET status='published' WHERE id=$1", [
      property,
    ]);
    for (const file of files.filter((f) => f >= '20261014130000'))
      await admin.query(readFileSync(resolve(migrationDir, file), 'utf8'));
    const appUrl = new URL(connectionString);
    appUrl.username = 'app_user';
    appUrl.password = '';
    pool = new Pool({ connectionString: appUrl.toString() });
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        DatabaseModule,
        CommonModule,
        ProfilesModule,
        PrivacyModule,
        EvidenceModule,
        LandlordsModule,
        MeModule,
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: {
          switchToHttp(): {
            getRequest(): {
              headers: { authorization?: string };
              user?: { id: string };
            };
          };
        }) {
          const req = context.switchToHttp().getRequest();
          const id = req.headers.authorization?.replace(/^Bearer /, '');
          if (!id || !identities.has(id)) throw new UnauthorizedException();
          req.user = { id };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  }, 30000);
  afterAll(async () => {
    if (app) await app.close();
    else if (pool) await pool.end();
    if (admin) await admin.end();
  });

  it('preserves pre-migration profiles, evidence and properties', async () => {
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
      .send({ termsVersion: 'v1', accepted: true })
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
  it('reports unconfigured legal content and defaults optional consents to false', async () => {
    await request(app.getHttpServer()).get('/legal/documents').expect(503);
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
      `INSERT INTO leri_legal_documents (kind,version,title,content,published_at) VALUES ('terms','v1','Demo terms','Synthetic test terms',now()),('privacy_notice','v1','Demo privacy','Synthetic test notice',now()),('terms','draft','Draft','Hidden draft',NULL)`,
    );
    const { body: docs } = await request(app.getHttpServer())
      .get('/legal/documents')
      .expect(200);
    expect(docs.terms.version).toBe('v1');
    expect(docs.terms.demoOnly).toBe(true);
    const first = await post(renter, '/me/privacy/terms-acceptance', {
      termsVersion: 'v1',
      accepted: true,
    }).expect(200);
    const second = await post(renter, '/me/privacy/terms-acceptance', {
      termsVersion: 'v1',
      accepted: true,
    }).expect(200);
    expect(first.body).toEqual(second.body);
    await post(renter, '/me/privacy/notice-acknowledgement', {
      privacyNoticeVersion: 'v1',
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
        .set('Authorization', `Bearer ${renter}`)
        .send({ purpose: 'user_research', granted, privacyNoticeVersion: 'v1' })
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
      termsVersion: 'v1',
      accepted: false,
    }).expect(400);
    await request(app.getHttpServer())
      .put('/me/privacy/consents')
      .set('Authorization', `Bearer ${renter}`)
      .send({ purpose: 'anything', granted: true, privacyNoticeVersion: 'v1' })
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
          `INSERT INTO leri_terms_acceptances (user_id,document_id,accepted_at) SELECT $1,id,'2020-01-01' FROM leri_legal_documents WHERE kind='terms' AND version='v1'`,
          [renter],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      as(outsider, (db) =>
        db.query(
          `INSERT INTO leri_terms_acceptances (user_id,document_id) SELECT $1,id FROM leri_legal_documents WHERE kind='terms' AND version='v1'`,
          [renter],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      admin.query(
        `UPDATE leri_legal_documents SET content='Changed' WHERE kind='terms' AND version='v1'`,
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
    await admin.query(
      "UPDATE leri_evidence_catalogue SET active=false WHERE id='affordability.payslips'",
    );
    expect((await get(renter, '/evidence/catalogue')).body).toHaveLength(53);
    expect(
      (
        await admin.query('SELECT * FROM evidence_items WHERE id=$1', [
          evidence,
        ])
      ).rowCount,
    ).toBe(1);
  });
});
