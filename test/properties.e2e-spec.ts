import { INestApplication } from '@nestjs/common';
import type { Property, PropertyFeedResponse } from '@yourorg/ile-shared-types';
import { App } from 'supertest/types';
import {
  api,
  AppUserDb,
  createApp,
  createUser,
  TestUser,
  VALID_PROPERTY,
} from './helpers';

describe('Properties (e2e)', () => {
  let app: INestApplication<App>;
  let db: AppUserDb;
  let landlord: TestUser;
  let otherLandlord: TestUser;
  let renter: TestUser;

  beforeAll(async () => {
    app = await createApp();
    db = new AppUserDb();
    [landlord, otherLandlord, renter] = await Promise.all([
      createUser('landlord', 'Landlord'),
      createUser('landlord', 'Other Landlord'),
      createUser('renter', 'Renter'),
    ]);
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  async function createDraft(owner = landlord): Promise<Property> {
    const res = await api(app, owner)
      .post('/properties', VALID_PROPERTY)
      .expect(201);
    return res.body as Property;
  }

  describe('create', () => {
    it('creates a draft owned by the landlord, in the shared Property shape', async () => {
      const property = await createDraft();
      expect(property).toEqual({
        id: expect.any(String),
        landlordId: landlord.id,
        title: 'Bright two-bed flat',
        description: 'Close to the station.',
        addressLine1: '12 Example Street',
        city: 'Edinburgh',
        postcode: 'EH1 1AA',
        bedrooms: 2,
        rentAmount: 1250.5,
        currency: 'GBP',
        propertyRules: ['no_smoking'],
        status: 'draft',
        publishedAt: null,
        archivedAt: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it('rejects a renter', async () => {
      await api(app, renter).post('/properties', VALID_PROPERTY).expect(403);
    });

    it('rejects a client-supplied status', async () => {
      await api(app, landlord)
        .post('/properties', { ...VALID_PROPERTY, status: 'published' })
        .expect(400);
    });

    it.each([
      ['bedrooms out of range', { bedrooms: 21 }],
      ['non-positive rent', { rentAmount: 0 }],
      ['unknown rule', { propertyRules: ['no_parties'] }],
      ['empty address', { addressLine1: '' }],
    ])('rejects %s', async (_label, override) => {
      await api(app, landlord)
        .post('/properties', { ...VALID_PROPERTY, ...override })
        .expect(400);
    });

    it('requires authentication', async () => {
      await api(app, { ...landlord, token: 'garbage' })
        .post('/properties', VALID_PROPERTY)
        .expect(401);
    });
  });

  describe('visibility', () => {
    it("lists only the landlord's own properties on /properties/me", async () => {
      const mine = await createDraft();
      const theirs = await createDraft(otherLandlord);
      const res = await api(app, landlord).get('/properties/me').expect(200);
      const ids = (res.body as Property[]).map((p) => p.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
      expect(
        (res.body as Property[]).every((p) => p.landlordId === landlord.id),
      ).toBe(true);
    });

    it('hides a draft from renters and from other landlords', async () => {
      const draft = await createDraft();
      await api(app, landlord).get(`/properties/${draft.id}`).expect(200);
      await api(app, renter).get(`/properties/${draft.id}`).expect(404);
      await api(app, otherLandlord).get(`/properties/${draft.id}`).expect(404);

      const feed = await api(app, renter)
        .get('/properties?limit=50')
        .expect(200);
      expect(
        (feed.body as PropertyFeedResponse).items.map((p) => p.id),
      ).not.toContain(draft.id);
    });

    it('shows a published property to renters (detail + feed) but not to other landlords', async () => {
      const draft = await createDraft();
      await api(app, landlord)
        .post(`/properties/${draft.id}/publish`)
        .expect(200);

      await api(app, renter).get(`/properties/${draft.id}`).expect(200);
      await api(app, otherLandlord).get(`/properties/${draft.id}`).expect(404);

      const feed = await api(app, renter)
        .get('/properties?limit=50')
        .expect(200);
      const body = feed.body as PropertyFeedResponse;
      expect(body.items.map((p) => p.id)).toContain(draft.id);
      expect(body.items.every((p) => p.status === 'published')).toBe(true);
    });

    it('restricts the feed to renters', async () => {
      await api(app, landlord).get('/properties').expect(403);
    });

    it('pages the feed', async () => {
      const first = await createDraft();
      const second = await createDraft();
      await api(app, landlord)
        .post(`/properties/${first.id}/publish`)
        .expect(200);
      await api(app, landlord)
        .post(`/properties/${second.id}/publish`)
        .expect(200);

      const page1 = (
        await api(app, renter).get('/properties?limit=1&offset=0').expect(200)
      ).body as PropertyFeedResponse;
      const page2 = (
        await api(app, renter).get('/properties?limit=1&offset=1').expect(200)
      ).body as PropertyFeedResponse;
      expect(page1).toMatchObject({ limit: 1, offset: 0, hasMore: true });
      expect(page1.items).toHaveLength(1);
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].id).not.toBe(page1.items[0].id);
    });

    it('validates paging params', async () => {
      await api(app, renter).get('/properties?limit=0').expect(400);
      await api(app, renter).get('/properties?limit=51').expect(400);
      await api(app, renter).get('/properties?offset=-1').expect(400);
    });

    it('rejects a non-UUID id', async () => {
      await api(app, landlord).get('/properties/not-a-uuid').expect(400);
    });
  });

  describe('update', () => {
    it('lets the owner edit details', async () => {
      const draft = await createDraft();
      const res = await api(app, landlord)
        .patch(`/properties/${draft.id}`, {
          rentAmount: 1300,
          propertyRules: [],
          title: null,
        })
        .expect(200);
      expect(res.body).toMatchObject({
        rentAmount: 1300,
        propertyRules: [],
        title: null,
      });
    });

    it('denies other landlords and renters (404)', async () => {
      const draft = await createDraft();
      await api(app, otherLandlord)
        .patch(`/properties/${draft.id}`, { city: 'X' })
        .expect(404);
      await api(app, renter)
        .patch(`/properties/${draft.id}`, { city: 'X' })
        .expect(404);
      const res = await api(app, landlord)
        .get(`/properties/${draft.id}`)
        .expect(200);
      expect(res.body.city).toBe('Edinburgh');
    });

    it('rejects status, nulls on required fields, and empty bodies', async () => {
      const draft = await createDraft();
      await api(app, landlord)
        .patch(`/properties/${draft.id}`, { status: 'published' })
        .expect(400);
      await api(app, landlord)
        .patch(`/properties/${draft.id}`, { addressLine1: null })
        .expect(400);
      await api(app, landlord).patch(`/properties/${draft.id}`, {}).expect(400);
    });
  });

  describe('publish / archive', () => {
    it('publishes a draft once, then archives it', async () => {
      const draft = await createDraft();
      const published = await api(app, landlord)
        .post(`/properties/${draft.id}/publish`)
        .expect(200);
      expect(published.body).toMatchObject({
        status: 'published',
        publishedAt: expect.any(String),
      });

      await api(app, landlord)
        .post(`/properties/${draft.id}/publish`)
        .expect(409);

      const archived = await api(app, landlord)
        .post(`/properties/${draft.id}/archive`)
        .expect(200);
      expect(archived.body).toMatchObject({
        status: 'archived',
        archivedAt: expect.any(String),
      });

      // Archived: read-only, can't be republished, invisible to renters.
      await api(app, landlord)
        .post(`/properties/${draft.id}/publish`)
        .expect(409);
      await api(app, landlord)
        .post(`/properties/${draft.id}/archive`)
        .expect(409);
      await api(app, landlord)
        .patch(`/properties/${draft.id}`, { city: 'X' })
        .expect(409);
      await api(app, renter).get(`/properties/${draft.id}`).expect(404);
    });

    it('denies publish/archive to non-owners (404)', async () => {
      const draft = await createDraft();
      await api(app, otherLandlord)
        .post(`/properties/${draft.id}/publish`)
        .expect(404);
      await api(app, renter)
        .post(`/properties/${draft.id}/archive`)
        .expect(404);
    });

    it('blocks publishing for an unverified landlord when REQUIRE_VERIFICATION=true', async () => {
      const draft = await createDraft();
      process.env.REQUIRE_VERIFICATION = 'true';
      try {
        await api(app, landlord)
          .post(`/properties/${draft.id}/publish`)
          .expect(403);
      } finally {
        delete process.env.REQUIRE_VERIFICATION;
      }
      await api(app, landlord)
        .post(`/properties/${draft.id}/publish`)
        .expect(200);
    });
  });

  // Straight to the database as app_user -- these hold for any query,
  // not just the routes above.
  describe('RLS and triggers (direct SQL as app_user)', () => {
    let draftId: string;
    let publishedId: string;

    beforeAll(async () => {
      draftId = (await createDraft()).id;
      publishedId = (await createDraft()).id;
      await api(app, landlord)
        .post(`/properties/${publishedId}/publish`)
        .expect(200);
    });

    const count = (userId: string, id: string) =>
      db.outcome(userId, 'SELECT 1 FROM properties WHERE id = $1', [id]);

    it('SELECT: raw property rows are owner-only; renters use safe projections', async () => {
      expect(await count(landlord.id, draftId)).toBe('ok:1');
      expect(await count(renter.id, draftId)).toBe('ok:0');
      expect(await count(renter.id, publishedId)).toBe('ok:0');
      expect(
        await db.outcome(
          renter.id,
          'SELECT 1 WHERE leri_public_property($1) IS NOT NULL',
          [publishedId],
        ),
      ).toBe('ok:1');
      expect(await count(otherLandlord.id, draftId)).toBe('ok:0');
      expect(await count(otherLandlord.id, publishedId)).toBe('ok:0');
    });

    it('SELECT without a valid app.current_user_id fails closed', async () => {
      expect(
        await db.outcome('', 'SELECT 1 FROM properties WHERE id = $1', [
          publishedId,
        ]),
      ).toBe(
        '22P02', // '' is not a uuid: the policy cast fails closed
      );
    });

    it('UPDATE/DELETE: non-owners affect zero rows', async () => {
      for (const user of [otherLandlord, renter]) {
        expect(
          await db.outcome(
            user.id,
            "UPDATE properties SET city = 'X' WHERE id = $1",
            [publishedId],
          ),
        ).toBe('ok:0');
        expect(
          await db.outcome(user.id, 'DELETE FROM properties WHERE id = $1', [
            draftId,
          ]),
        ).toBe('ok:0');
      }
    });

    it('UPDATE: owner cannot give the property to another landlord', async () => {
      expect(
        await db.outcome(
          landlord.id,
          'UPDATE properties SET landlord_id = $2 WHERE id = $1',
          [draftId, otherLandlord.id],
        ),
      ).toBe('42501');
    });

    it('DELETE: owner can delete their own draft', async () => {
      expect(
        await db.outcome(landlord.id, 'DELETE FROM properties WHERE id = $1', [
          draftId,
        ]),
      ).toBe('ok:1');
    });

    it('INSERT: renter cannot insert; landlord cannot insert for someone else or as published', async () => {
      const insert = (ownerId: string, status = 'draft') =>
        `INSERT INTO properties (landlord_id, address_line1, city, postcode, bedrooms, rent_amount, status)
         VALUES ('${ownerId}', 'a', 'b', 'c', 1, 100, '${status}')`;
      expect(await db.outcome(renter.id, insert(landlord.id))).toBe('42501');
      expect(await db.outcome(landlord.id, insert(otherLandlord.id))).toBe(
        '42501',
      );
      expect(
        await db.outcome(landlord.id, insert(landlord.id, 'published')),
      ).toBe('42501');
      expect(await db.outcome(landlord.id, insert(landlord.id))).toBe('ok:1');
    });

    it('status trigger: published -> draft is illegal even for the owner', async () => {
      expect(
        await db.outcome(
          landlord.id,
          "UPDATE properties SET status = 'draft' WHERE id = $1",
          [publishedId],
        ),
      ).toBe('23514');
    });

    it('status trigger: nothing leaves archived', async () => {
      const id = (await createDraft()).id;
      await api(app, landlord).post(`/properties/${id}/archive`).expect(200);
      for (const status of ['draft', 'published']) {
        expect(
          await db.outcome(
            landlord.id,
            'UPDATE properties SET status = $2 WHERE id = $1',
            [id, status],
          ),
        ).toBe('23514');
      }
    });
  });
});
