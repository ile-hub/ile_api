import sharp from 'sharp';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
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
import { assertIsolatedTarget } from './isolated-target';
let PNG: Buffer;
const PDF = Buffer.from(
  '%PDF-1.4\nSynthetic private supporting document\n%%EOF',
);
const ORDER = ['affordability', 'reliability', 'community', 'stability'];
const DETAILS = {
  privateReference: 'PRIVATE REFERENCE',
  publicArea: 'Central Edinburgh',
  postcodeDistrict: 'EH1',
  depositAmount: 1500,
  billsIncluded: ['water'],
  billsExcluded: ['gas', 'electricity', 'internet'],
  availableFrom: '2026-11-01',
  minTenancyMonths: 6,
  expectedTenancyMonths: 12,
  propertyType: 'flat',
  bathrooms: 1,
  permittedOccupants: 2,
  furnishing: 'furnished',
  keyFeatures: ['Bright living room'],
  councilTaxBand: 'D',
  epcRating: 'C',
  hmoLicenceStatus: 'not_required',
  hmoLicenceDetails: 'PRIVATE HMO DETAILS',
  registrationNumbers: ['PRIVATE REGISTRATION'],
  registrationDetails: 'PRIVATE REGISTRATION DETAILS',
  heating: 'Gas central heating',
  energyFeatures: ['Double glazing'],
  parking: 'On-street',
  outdoorSpace: 'Shared garden',
  accessibilityFeatures: ['Ground floor'],
  petsPolicy: 'considered',
  smokingPolicy: 'not_allowed',
  otherConditions: 'Respect shared spaces',
  walkthroughUrl: 'https://example.com/synthetic-tour',
  walkthroughType: 'video',
};
describe('Phase 2 real Supabase evidence, preferences, properties and Storage', () => {
  let app: INestApplication<App>, admin: Pool, db: AppUserDb;
  let renter: TestUser,
    other: TestUser,
    landlord: TestUser,
    otherLandlord: TestUser;
  let selection: string,
    secondSelection: string,
    document: string,
    property: string,
    secondProperty: string,
    photo: string;
  const upload = (
    user: TestUser,
    path: string,
    buffer: Buffer = PDF,
    mime = 'application/pdf',
    name = 'PRIVATE-document.pdf',
  ) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${user.token}`)
      .attach('file', buffer, { filename: name, contentType: mime });
  const remove = (user: TestUser, path: string) =>
    request(app.getHttpServer())
      .delete(path)
      .set('Authorization', `Bearer ${user.token}`);
  const put = (user: TestUser, path: string, body: object) =>
    request(app.getHttpServer())
      .put(path)
      .set('Authorization', `Bearer ${user.token}`)
      .send(body);
  const storage = (
    user: TestUser,
    path: string,
    method = 'GET',
    body?: Buffer,
  ) =>
    fetch(`${process.env.SUPABASE_URL}/storage/v1/${path}`, {
      method,
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY!,
        Authorization: `Bearer ${user.token}`,
        'Content-Type': 'application/pdf',
      },
      body: body ? new Uint8Array(body) : undefined,
    });
  beforeAll(async () => {
    if (process.env.E2E_ISOLATED_LOCAL !== '1')
      throw new Error('Use the isolated Supabase runner');
    assertIsolatedTarget();
    PNG = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    admin = new Pool({ connectionString: process.env.E2E_ADMIN_DATABASE_URL });
    db = new AppUserDb();
    app = await createApp();
    [renter, other, landlord, otherLandlord] = await Promise.all([
      createUser('renter', 'Phase 2 renter'),
      createUser('renter', 'Other renter'),
      createUser('landlord', 'Phase 2 landlord'),
      createUser('landlord', 'Other landlord'),
    ]);
    await admin.query(
      'UPDATE renter_profiles SET is_demo=true WHERE user_id=ANY($1::uuid[])',
      [[renter.id, other.id]],
    );
    await admin.query(
      'UPDATE landlord_profiles SET is_demo=true WHERE user_id=ANY($1::uuid[])',
      [[landlord.id, otherLandlord.id]],
    );
    await api(app, renter)
      .patch('/me/profile', {
        discoverable: true,
        personalStory: 'Synthetic story',
      })
      .expect(200);
    await api(app, landlord)
      .patch('/me/profile', { discoverable: true })
      .expect(200);
  });
  afterAll(async () => {
    if (db) await db.end();
    if (app) await app.close();
    if (admin) await admin.end();
  });
  it('requires real authentication on evidence, files and preferences', async () => {
    for (const path of [
      '/evidence/summary',
      '/landlords/me/arcs-preferences',
      `/properties/${randomUUID()}/photos`,
    ])
      await request(app.getHttpServer()).get(path).expect(401);
    await request(app.getHttpServer())
      .post(`/evidence/${randomUUID()}/documents`)
      .attach('file', PDF, {
        filename: 'dummy.pdf',
        contentType: 'application/pdf',
      })
      .expect(401);
  });
  it('persists several optional evidence pathways in a strand', async () => {
    selection = (
      await api(app, renter)
        .post('/evidence', {
          pillar: 'affordability',
          catalogueId: 'affordability.savings',
          explanation: 'PRIVATE SAVINGS ACCOUNT',
        })
        .expect(201)
    ).body.id as string;
    secondSelection = (
      await api(app, renter)
        .post('/evidence', {
          pillar: 'affordability',
          catalogueId: 'affordability.gig_earnings',
          explanation: 'PRIVATE EARNINGS',
        })
        .expect(201)
    ).body.id as string;
    const own = await api(app, renter).get('/evidence').expect(200);
    expect(own.body).toHaveLength(2);
    expect(
      (await api(app, renter).get(`/evidence/${selection}`)).body.explanation,
    ).toBe('PRIVATE SAVINGS ACCOUNT');
    await api(app, renter)
      .post('/evidence', {
        pillar: 'affordability',
        catalogueId: 'affordability.savings',
      })
      .expect(409);
  });
  it('edits explanations and catalogue selections without exposing status controls', async () => {
    await api(app, renter)
      .patch(`/evidence/${selection}`, {
        explanation: 'PRIVATE UPDATED ACCOUNT',
      })
      .expect(200);
    expect(
      (await api(app, renter).get(`/evidence/${selection}`)).body.explanation,
    ).toBe('PRIVATE UPDATED ACCOUNT');
    await api(app, renter)
      .patch(`/evidence/${selection}`, {
        catalogueId: 'reliability.rent_history',
      })
      .expect(400);
    await api(app, renter)
      .patch(`/evidence/${selection}`, { status: 'verified' })
      .expect(400);
    await api(app, other)
      .patch(`/evidence/${selection}`, { explanation: 'Hacked' })
      .expect(404);
  });
  it('uploads a supporting PDF privately and returns owner-only metadata', async () => {
    const response = await upload(
      renter,
      `/evidence/${selection}/documents`,
    ).expect(201);
    document = response.body.id as string;
    expect(response.body).toMatchObject({
      evidenceId: selection,
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
    });
    expect(response.body).not.toHaveProperty('objectPath');
    expect(
      (await api(app, renter).get(`/evidence/${selection}/documents`)).body,
    ).toHaveLength(1);
    await upload(other, `/evidence/${selection}/documents`).expect(404);
    await api(app, landlord)
      .get(`/evidence/${selection}/documents`)
      .expect(403);
  });
  it('rejects spoofed, empty, oversized and unsupported files before storage', async () => {
    await upload(
      renter,
      `/evidence/${selection}/documents`,
      Buffer.from('<svg>bad</svg>'),
      'image/png',
      'fake.png',
    ).expect(400);
    await upload(
      renter,
      `/evidence/${selection}/documents`,
      Buffer.alloc(0),
    ).expect(400);
    await upload(
      renter,
      `/evidence/${selection}/documents`,
      Buffer.alloc(5 * 1024 * 1024 + 1),
    ).expect(413);
    expect(
      (await api(app, renter).get(`/evidence/${selection}/documents`)).body,
    ).toHaveLength(1);
  });
  it('returns safe evidence summaries in the owner preview and public profile', async () => {
    const summary = await api(app, renter).get('/evidence/summary').expect(200);
    expect(summary.body).toHaveLength(4);
    expect(summary.body[0]).toMatchObject({
      pillar: 'affordability',
      status: 'Document uploaded',
    });
    expect(summary.body[0].categories).toHaveLength(2);
    expect(summary.body[1].status).toBe('Not provided');
    const visible = await api(app, landlord)
      .get(`/profiles/${renter.id}`)
      .expect(200);
    const preview = await api(app, renter)
      .get('/me/profile/preview')
      .expect(200);
    expect(visible.body).toEqual(preview.body);
    expect(JSON.stringify(visible.body)).not.toMatch(
      /PRIVATE|ACCOUNT|fileName|object_path|payload|explanation|riskScore/,
    );
  });
  it('only the owner can obtain a short-lived document link or access its raw Storage object', async () => {
    const link = await api(app, renter)
      .get(`/evidence/${selection}/documents/${document}/download`)
      .expect(200);
    expect(link.body.expiresIn).toBe(60);
    const response = await fetch(link.body.url as string);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PDF);
    await api(app, other)
      .get(`/evidence/${selection}/documents/${document}/download`)
      .expect(404);
    const path = (
      await admin.query(
        'SELECT object_path FROM leri_evidence_documents WHERE id=$1',
        [document],
      )
    ).rows[0].object_path as string;
    const denied = await storage(
      other,
      `object/leri-evidence-private-v2/${path}`,
    );
    expect([400, 401, 403, 404]).toContain(denied.status);
    const forged = await storage(
      other,
      `object/leri-evidence-private-v2/${renter.id}/evidence/${selection}/${randomUUID()}`,
      'POST',
      PDF,
    );
    expect([400, 401, 403]).toContain(forged.status);
    const publicly = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/public/leri-evidence-private-v2/${path}`,
    );
    expect([400, 401, 403, 404]).toContain(publicly.status);
  });
  it('removes the actual object while retaining metadata history', async () => {
    await remove(other, `/evidence/${selection}/documents/${document}`).expect(
      404,
    );
    await remove(renter, `/evidence/${selection}/documents/${document}`).expect(
      200,
    );
    expect(
      (await api(app, renter).get(`/evidence/${selection}/documents`)).body,
    ).toHaveLength(0);
    await api(app, renter)
      .get(`/evidence/${selection}/documents/${document}/download`)
      .expect(404);
    const record = (
      await admin.query(
        'SELECT object_path,removed_at FROM leri_evidence_documents WHERE id=$1',
        [document],
      )
    ).rows[0];
    expect(record.removed_at).not.toBeNull();
    expect(
      (
        await admin.query(
          'SELECT * FROM storage.objects WHERE bucket_id=$1 AND name=$2',
          ['leri-evidence-private-v2', record.object_path],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await api(app, renter).get('/evidence/summary')).body[0].status,
    ).toBe('Information added');
  });
  it('deselects evidence without deleting historical records and removes attached files', async () => {
    const uploaded = await upload(
      renter,
      `/evidence/${secondSelection}/documents`,
    ).expect(201);
    await remove(renter, `/evidence/${secondSelection}`).expect(200);
    await api(app, renter).get(`/evidence/${secondSelection}`).expect(404);
    expect(
      (
        await admin.query('SELECT deleted_at FROM evidence_items WHERE id=$1', [
          secondSelection,
        ])
      ).rows[0].deleted_at,
    ).not.toBeNull();
    expect(
      (
        await admin.query(
          'SELECT removed_at FROM leri_evidence_documents WHERE id=$1',
          [uploaded.body.id],
        )
      ).rows[0].removed_at,
    ).not.toBeNull();
    expect(
      (await api(app, renter).get('/evidence/summary')).body[0].categories,
    ).toHaveLength(1);
  });
  it('saves reorderable landlord ARCS defaults and evidence choices', async () => {
    await put(landlord, '/landlords/me/arcs-preferences', {
      priorityOrder: [...ORDER].reverse(),
      evidencePreferences: {
        'affordability.savings': 'accept',
        'reliability.rent_history': 'prefer',
        'community.guarantor': 'not_needed',
      },
    }).expect(200);
    const result = await api(app, landlord)
      .get('/landlords/me/arcs-preferences')
      .expect(200);
    expect(result.body.priorityOrder).toEqual([...ORDER].reverse());
    expect(result.body.evidencePreferences['affordability.savings']).toBe(
      'accept',
    );
    await api(app, renter).get('/landlords/me/arcs-preferences').expect(403);
  });
  it('rejects duplicate rankings, unknown options and invalid evidence preference choices', async () => {
    await put(landlord, '/landlords/me/arcs-preferences', {
      priorityOrder: [
        'affordability',
        'affordability',
        'community',
        'stability',
      ],
      evidencePreferences: {},
    }).expect(400);
    await put(landlord, '/landlords/me/arcs-preferences', {
      priorityOrder: ORDER,
      evidencePreferences: { unknown: 'prefer' },
    }).expect(400);
    await put(landlord, '/landlords/me/arcs-preferences', {
      priorityOrder: ORDER,
      evidencePreferences: { 'affordability.savings': null },
    }).expect(400);
    await put(landlord, '/landlords/me/arcs-preferences', {
      priorityOrder: ORDER,
      evidencePreferences: {},
      riskScore: 99,
    }).expect(400);
  });
  it('creates two fully detailed drafts while keeping private details owner-visible', async () => {
    property = (
      await api(app, landlord)
        .post('/properties', { ...VALID_PROPERTY, details: DETAILS })
        .expect(201)
    ).body.id as string;
    secondProperty = (
      await api(app, landlord)
        .post('/properties', {
          ...VALID_PROPERTY,
          title: 'Second synthetic home',
          details: DETAILS,
        })
        .expect(201)
    ).body.id as string;
    const owned = await api(app, landlord)
      .get(`/properties/${property}`)
      .expect(200);
    expect(owned.body.details).toEqual(DETAILS);
    expect(owned.body.addressLine1).toBe(VALID_PROPERTY.addressLine1);
    expect(owned.body.listingStatus).toBe('draft');
    await api(app, landlord)
      .post(`/properties/${property}/publish`)
      .expect(400);
    await api(app, renter)
      .get(`/landlords/${landlord.id}/properties/${property}`)
      .expect(404);
  });
  it('uploads several photos and validates ownership and image content', async () => {
    photo = (
      await upload(
        landlord,
        `/properties/${property}/photos`,
        PNG,
        'image/png',
        'PRIVATE-photo.png',
      ).expect(201)
    ).body.id as string;
    await upload(
      landlord,
      `/properties/${property}/photos`,
      PNG,
      'image/png',
      'second.png',
    ).expect(201);
    await upload(
      landlord,
      `/properties/${secondProperty}/photos`,
      PNG,
      'image/png',
      'other.png',
    ).expect(201);
    await upload(
      otherLandlord,
      `/properties/${property}/photos`,
      PNG,
      'image/png',
      'forged.png',
    ).expect(404);
    await upload(
      landlord,
      `/properties/${property}/photos`,
      PDF,
      'application/pdf',
    ).expect(400);
    await api(app, landlord)
      .patch(`/properties/${property}/photos/${photo}`, {
        caption: 'Synthetic living room',
        position: 5,
      })
      .expect(200);
    expect(
      (await api(app, landlord).get(`/properties/${property}/photos`)).body,
    ).toHaveLength(2);
  });
  it('publishes complete listings and serves only safe details from every renter response', async () => {
    await api(app, landlord)
      .post(`/properties/${property}/publish`)
      .expect(200);
    await api(app, landlord)
      .post(`/properties/${secondProperty}/publish`)
      .expect(200);
    for (const path of [
      `/properties/${property}`,
      `/landlords/${landlord.id}/properties/${property}`,
      `/landlords/${landlord.id}/properties`,
      `/landlords/${landlord.id}`,
      `/profiles/${landlord.id}`,
      '/properties?limit=50',
    ]) {
      const result = await api(app, renter).get(path).expect(200);
      expect(JSON.stringify(result.body)).not.toMatch(
        /PRIVATE|addressLine1|"postcode"|privateReference|registrationNumbers|registrationDetails|hmoLicenceDetails|object_path|fileName/,
      );
    }
    const result = await api(app, renter)
      .get(`/landlords/${landlord.id}/properties/${property}`)
      .expect(200);
    expect(result.body.details).toMatchObject({
      publicArea: 'Central Edinburgh',
      postcodeDistrict: 'EH1',
      depositAmount: 1500,
      propertyType: 'flat',
    });
    expect(result.body.photos).toHaveLength(2);
    expect(result.body.listingStatus).toBe('available');
    await api(app, renter)
      .get(`/landlords/${otherLandlord.id}/properties/${property}`)
      .expect(404);
  });
  it('also redacts property addresses in historical tenancy-interest renter responses', async () => {
    const interest = await api(app, renter)
      .post('/tenancy-interests', { propertyId: property })
      .expect(201);
    expect(interest.body.property.city).toBe('Edinburgh');
    expect(interest.body.property).not.toHaveProperty('addressLine1');
    expect(interest.body.property).not.toHaveProperty('postcode');
    const owner = await api(app, landlord)
      .post('/tenancy-interests', { propertyId: property, renterId: renter.id })
      .expect(201);
    expect(owner.body.property.addressLine1).toBe(VALID_PROPERTY.addressLine1);
  });
  it('denies raw property rows and private media metadata to other users', async () => {
    expect(
      await db.outcome(
        renter.id,
        'SELECT address_line1,postcode,details FROM properties WHERE id=$1',
        [property],
      ),
    ).toBe('ok:0');
    expect(
      await db.outcome(
        otherLandlord.id,
        'SELECT * FROM leri_property_photos WHERE property_id=$1',
        [property],
      ),
    ).toBe('ok:0');
    expect(
      await db.outcome(
        other.id,
        'SELECT * FROM leri_evidence_documents WHERE evidence_id=$1',
        [selection],
      ),
    ).toBe('ok:0');
    await api(app, otherLandlord)
      .patch(`/properties/${property}`, {
        details: { privateReference: 'hacked' },
      })
      .expect(404);
  });
  it('applies defaults and custom property overrides without losing old overrides', async () => {
    expect(
      (await api(app, landlord).get(`/properties/${property}/arcs-preferences`))
        .body.mode,
    ).toBe('default');
    await put(landlord, `/properties/${property}/arcs-preferences`, {
      mode: 'custom',
      priorityOrder: ORDER,
      evidencePreferences: { 'stability.relocation': 'prefer' },
    }).expect(200);
    await put(landlord, '/landlords/me/arcs-preferences', {
      priorityOrder: [ORDER[1], ORDER[0], ORDER[2], ORDER[3]],
      evidencePreferences: { 'reliability.rent_history': 'accept' },
    }).expect(200);
    const custom = await api(app, landlord)
      .get(`/properties/${property}/arcs-preferences`)
      .expect(200);
    expect(custom.body.effective.priorityOrder).toEqual(ORDER);
    const inherited = await api(app, landlord)
      .get(`/properties/${secondProperty}/arcs-preferences`)
      .expect(200);
    expect(inherited.body.effective.priorityOrder[0]).toBe('reliability');
    await put(otherLandlord, `/properties/${property}/arcs-preferences`, {
      mode: 'default',
    }).expect(404);
    await put(landlord, `/properties/${property}/arcs-preferences`, {
      mode: 'default',
    }).expect(200);
    expect(
      (await api(app, landlord).get(`/properties/${property}/arcs-preferences`))
        .body.effective.priorityOrder[0],
    ).toBe('reliability');
    expect(
      (
        await admin.query(
          'SELECT * FROM landlord_preferences WHERE property_id=$1 AND is_mvp_settings',
          [property],
        )
      ).rowCount,
    ).toBe(1);
  });
  it('returns short-lived public photo links only while the listing is available', async () => {
    const link = await api(app, renter)
      .get(
        `/landlords/${landlord.id}/properties/${property}/photos/${photo}/download`,
      )
      .expect(200);
    expect(link.body.expiresIn).toBe(60);
    expect((await fetch(link.body.url as string)).status).toBe(200);
    await api(app, landlord)
      .post(`/properties/${property}/availability`, { status: 'unavailable' })
      .expect(200);
    await api(app, renter)
      .get(`/landlords/${landlord.id}/properties/${property}`)
      .expect(404);
    await api(app, renter)
      .get(
        `/landlords/${landlord.id}/properties/${property}/photos/${photo}/download`,
      )
      .expect(404);
    const path = (
      await admin.query(
        'SELECT object_path FROM leri_property_photos WHERE id=$1',
        [photo],
      )
    ).rows[0].object_path as string;
    expect([400, 401, 403, 404]).toContain(
      (await storage(renter, `object/leri-property-photos-v2/${path}`)).status,
    );
    expect(
      (await api(app, landlord).get(`/properties/${property}`)).body
        .listingStatus,
    ).toBe('unavailable');
    await api(app, landlord)
      .post(`/properties/${property}/availability`, { status: 'available' })
      .expect(200);
  });
  it('patches detailed fields without losing earlier private values and rejects inconsistent merges', async () => {
    const result = await api(app, landlord)
      .patch(`/properties/${property}`, { details: { parking: 'Off-street' } })
      .expect(200);
    expect(result.body.details.privateReference).toBe('PRIVATE REFERENCE');
    await api(app, landlord)
      .patch(`/properties/${property}`, { details: { minTenancyMonths: 24 } })
      .expect(400);
    await api(app, landlord)
      .patch(`/properties/${property}`, { details: { billsIncluded: ['gas'] } })
      .expect(400);
    await api(app, landlord)
      .patch(`/properties/${property}`, {
        details: { postcodeDistrict: 'EH1 1AA' },
      })
      .expect(400);
  });
  it('enforces catalogue/pillar, ranking and property constraints at PostgreSQL level', async () => {
    expect(
      await db.outcome(
        renter.id,
        "UPDATE evidence_items SET catalogue_id='reliability.rent_history' WHERE id=$1",
        [selection],
      ),
    ).toBe('23514');
    expect(
      await db.outcome(
        landlord.id,
        'UPDATE properties SET details=\'{"permittedOccupants":0}\' WHERE id=$1',
        [property],
      ),
    ).toBe('23514');
    expect(
      await db.outcome(
        landlord.id,
        "UPDATE landlord_preferences SET priority_order=ARRAY['affordability','affordability','community','stability'] WHERE landlord_id=$1",
        [landlord.id],
      ),
    ).toBe('23514');
  });
  it('removes photos from Storage and the public gallery while keeping historical metadata', async () => {
    await remove(
      otherLandlord,
      `/properties/${property}/photos/${photo}`,
    ).expect(404);
    await remove(landlord, `/properties/${property}/photos/${photo}`).expect(
      200,
    );
    const record = (
      await admin.query(
        'SELECT removed_at,object_path FROM leri_property_photos WHERE id=$1',
        [photo],
      )
    ).rows[0];
    expect(record.removed_at).not.toBeNull();
    expect(
      (
        await admin.query(
          'SELECT * FROM storage.objects WHERE bucket_id=$1 AND name=$2',
          ['leri-property-photos-v2', record.object_path],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await api(app, renter).get(
          `/landlords/${landlord.id}/properties/${property}`,
        )
      ).body.photos,
    ).toHaveLength(1);
  });
  it('hides a modern listing when its last photo is removed', async () => {
    const owned = await api(app, landlord)
      .get(`/properties/${property}/photos`)
      .expect(200);
    const finalPhoto = owned.body[0].id as string;
    await remove(
      landlord,
      `/properties/${property}/photos/${finalPhoto}`,
    ).expect(200);
    await api(app, renter)
      .get(`/landlords/${landlord.id}/properties/${property}`)
      .expect(404);
    expect(
      (await api(app, landlord).get(`/properties/${property}`)).body
        .listingStatus,
    ).toBe('unavailable');
  });
  it('preserves archive semantics and cannot republish archived listings via availability', async () => {
    await api(app, landlord)
      .post(`/properties/${secondProperty}/archive`)
      .expect(200);
    await api(app, landlord)
      .post(`/properties/${secondProperty}/availability`, {
        status: 'available',
      })
      .expect(409);
    await api(app, landlord)
      .patch(`/properties/${secondProperty}`, { details: { parking: 'New' } })
      .expect(409);
    const oldPhotos = await api(app, landlord)
      .get(`/properties/${secondProperty}/photos`)
      .expect(200);
    await remove(
      landlord,
      `/properties/${secondProperty}/photos/${oldPhotos.body[0].id}`,
    ).expect(200);
  });
});
