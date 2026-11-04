import { INestApplication } from '@nestjs/common';
import type {
  LandlordPublicProfile,
  Property,
} from '@yourorg/ile-shared-types';
import { randomUUID } from 'node:crypto';
import { App } from 'supertest/types';
import {
  api,
  AppUserDb,
  createApp,
  createUser,
  TestUser,
  VALID_PROPERTY,
} from './helpers';

describe('GET /landlords/:id (e2e)', () => {
  let app: INestApplication<App>;
  let db: AppUserDb;
  let landlord: TestUser; // has published, draft and archived properties
  let draftOnlyLandlord: TestUser;
  let archivedOnlyLandlord: TestUser;
  let renter: TestUser;
  let published: Property;
  let draft: Property;
  let archived: Property;

  async function create(owner: TestUser): Promise<Property> {
    const res = await api(app, owner)
      .post('/properties', VALID_PROPERTY)
      .expect(201);
    return res.body as Property;
  }

  beforeAll(async () => {
    app = await createApp();
    db = new AppUserDb();
    [landlord, draftOnlyLandlord, archivedOnlyLandlord, renter] =
      await Promise.all([
        createUser('landlord', 'Landlord'),
        createUser('landlord', 'Draft Landlord'),
        createUser('landlord', 'Archived Landlord'),
        createUser('renter', 'Renter'),
      ]);

    published = await create(landlord);
    await api(app, landlord)
      .post(`/properties/${published.id}/publish`)
      .expect(200);
    draft = await create(landlord);
    archived = await create(landlord);
    await api(app, landlord)
      .post(`/properties/${archived.id}/publish`)
      .expect(200);
    await api(app, landlord)
      .post(`/properties/${archived.id}/archive`)
      .expect(200);

    await create(draftOnlyLandlord);
    const gone = await create(archivedOnlyLandlord);
    await api(app, archivedOnlyLandlord)
      .post(`/properties/${gone.id}/publish`)
      .expect(200);
    await api(app, archivedOnlyLandlord)
      .post(`/properties/${gone.id}/archive`)
      .expect(200);
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  it('returns public fields and published properties only, to a renter', async () => {
    const res = await api(app, renter)
      .get(`/landlords/${landlord.id}`)
      .expect(200);
    // toEqual: any extra field (email, phone, verification status, company,
    // draft/archived properties) fails this.
    expect(res.body).toEqual({
      id: landlord.id,
      displayName: landlord.displayName,
      memberSince: expect.any(String),
      properties: [
        {
          id: published.id,
          city: 'Edinburgh',
          bedrooms: 2,
          rentAmount: 1250.5,
        },
      ],
    });
    const ids = (res.body as LandlordPublicProfile).properties.map((p) => p.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(archived.id);
  });

  it('404s for a landlord with no published property', async () => {
    await api(app, renter)
      .get(`/landlords/${draftOnlyLandlord.id}`)
      .expect(404);
    await api(app, renter)
      .get(`/landlords/${archivedOnlyLandlord.id}`)
      .expect(404);
  });

  it('404s for ids that are not a landlord at all', async () => {
    await api(app, renter).get(`/landlords/${randomUUID()}`).expect(404);
    await api(app, renter).get(`/landlords/${renter.id}`).expect(404);
  });

  it('blocks landlord callers, including for their own id', async () => {
    await api(app, landlord).get(`/landlords/${landlord.id}`).expect(403);
    await api(app, draftOnlyLandlord)
      .get(`/landlords/${landlord.id}`)
      .expect(403);
  });

  it('validates the id', async () => {
    await api(app, renter).get('/landlords/not-a-uuid').expect(400);
  });

  it('landlord_profiles RLS: only the landlord can read their own row', async () => {
    const read = (callerId: string, landlordId: string) =>
      db.outcome(
        callerId,
        'SELECT company_name, verification_status FROM landlord_profiles WHERE user_id = $1',
        [landlordId],
      );
    expect(await read(landlord.id, landlord.id)).toBe('ok:1');
    expect(await read(renter.id, landlord.id)).toBe('ok:0');
    expect(await read(draftOnlyLandlord.id, landlord.id)).toBe('ok:0');
    expect(
      await db.outcome(
        landlord.id,
        "UPDATE landlord_profiles SET verification_status = 'verified' WHERE user_id = $1",
        [landlord.id],
      ),
    ).toBe('42501'); // Protected columns are denied before row-level filtering.
    expect(
      await db.outcome(
        draftOnlyLandlord.id,
        "UPDATE landlord_profiles SET bio = 'unauthorised edit' WHERE user_id = $1",
        [landlord.id],
      ),
    ).toBe('ok:0'); // Editable columns still enforce cross-user RLS.
  });

  it('the SQL function itself only answers renters, for published landlords', async () => {
    const call = (callerId: string, landlordId: string) =>
      db.outcome(callerId, 'SELECT * FROM landlord_public_profile($1)', [
        landlordId,
      ]);
    expect(await call(renter.id, landlord.id)).toBe('ok:1');
    expect(await call(renter.id, draftOnlyLandlord.id)).toBe('ok:0');
    expect(await call(landlord.id, landlord.id)).toBe('ok:0');
    expect(await call(draftOnlyLandlord.id, landlord.id)).toBe('ok:0');
  });
});
