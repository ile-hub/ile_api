import { INestApplication } from '@nestjs/common';
import type { Property, TenancyInterest } from '@yourorg/ile-shared-types';
import { App } from 'supertest/types';
import {
  api,
  AppUserDb,
  createApp,
  createUser,
  TestUser,
  VALID_PROPERTY,
} from './helpers';

describe('Tenancy interests (e2e)', () => {
  let app: INestApplication<App>;
  let db: AppUserDb;
  let landlord: TestUser;
  let otherLandlord: TestUser;
  let renter: TestUser;
  let otherRenter: TestUser;

  beforeAll(async () => {
    app = await createApp();
    db = new AppUserDb();
    [landlord, otherLandlord, renter, otherRenter] = await Promise.all([
      createUser('landlord', 'Landlord'),
      createUser('landlord', 'Other Landlord'),
      createUser('renter', 'Renter'),
      createUser('renter', 'Other Renter'),
    ]);
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  async function property(publish = true): Promise<Property> {
    const res = await api(app, landlord)
      .post('/properties', VALID_PROPERTY)
      .expect(201);
    if (publish) {
      await api(app, landlord)
        .post(`/properties/${res.body.id}/publish`)
        .expect(200);
    }
    return res.body as Property;
  }

  async function renterInterest(
    user: TestUser,
    propertyId: string,
  ): Promise<TenancyInterest> {
    const res = await api(app, user)
      .post('/tenancy-interests', { propertyId })
      .expect(201);
    return res.body as TenancyInterest;
  }

  describe('expressing interest', () => {
    // toEqual, not toMatchObject: any extra field in either view (e.g.
    // trust or compatibility data) fails these.
    it('renter view: listing details + landlord name, nothing else', async () => {
      const p = await property();
      const interest = await renterInterest(renter, p.id);
      expect(interest).toEqual({
        id: expect.any(String),
        renterId: renter.id,
        propertyId: p.id,
        status: 'pending',
        renterInterestedAt: expect.any(String),
        landlordInterestedAt: null,
        matchedAt: null,
        createdAt: expect.any(String),
        viewerSide: 'renter',
        counterparty: { displayName: landlord.displayName },
        property: {
          title: 'Bright two-bed flat',
          description: 'Close to the station.',
          propertyRules: ['no_smoking'],
          city: 'Edinburgh',
          bedrooms: 2,
          rentAmount: 1250.5,
          currency: 'GBP',
        },
      });
    });

    it('landlord view: property summary + renter name, nothing else', async () => {
      const p = await property();
      const interest = await renterInterest(renter, p.id);
      const res = await api(app, landlord)
        .get(`/tenancy-interests/${interest.id}`)
        .expect(200);
      expect(res.body).toEqual({
        id: interest.id,
        renterId: renter.id,
        propertyId: p.id,
        status: 'pending',
        renterInterestedAt: expect.any(String),
        landlordInterestedAt: null,
        matchedAt: null,
        createdAt: expect.any(String),
        viewerSide: 'landlord',
        counterparty: { displayName: renter.displayName },
        property: {
          addressLine1: '12 Example Street',
          city: 'Edinburgh',
          postcode: 'EH1 1AA',
          bedrooms: 2,
          rentAmount: 1250.5,
          currency: 'GBP',
        },
      });
    });

    it('landlord interest back -> matched; each side sees the other party name', async () => {
      const p = await property();
      const pending = await renterInterest(renter, p.id);
      const matched = await api(app, landlord)
        .post('/tenancy-interests', { propertyId: p.id, renterId: renter.id })
        .expect(201);
      expect(matched.body).toMatchObject({
        id: pending.id,
        status: 'matched',
        matchedAt: expect.any(String),
        counterparty: { displayName: renter.displayName },
      });

      const renterView = await api(app, renter)
        .get(`/tenancy-interests/${pending.id}`)
        .expect(200);
      expect(renterView.body).toMatchObject({
        status: 'matched',
        counterparty: { displayName: landlord.displayName },
      });

      for (const user of [renter, landlord]) {
        const res = await api(app, user)
          .get('/tenancy-interests/me?status=matched')
          .expect(200);
        expect((res.body as TenancyInterest[]).map((i) => i.id)).toContain(
          pending.id,
        );
      }
    });

    it('is idempotent and keeps the first timestamp', async () => {
      const p = await property();
      const first = await renterInterest(renter, p.id);
      const again = await renterInterest(renter, p.id);
      expect(again.id).toBe(first.id);
      expect(again.renterInterestedAt).toBe(first.renterInterestedAt);
    });

    it('rejects a property that is not published', async () => {
      const draft = await property(false);
      await api(app, renter)
        .post('/tenancy-interests', { propertyId: draft.id })
        .expect(404);
      await api(app, landlord)
        .post('/tenancy-interests', {
          propertyId: draft.id,
          renterId: renter.id,
        })
        .expect(409);

      const archived = await property();
      await api(app, landlord)
        .post(`/properties/${archived.id}/archive`)
        .expect(200);
      await api(app, renter)
        .post('/tenancy-interests', { propertyId: archived.id })
        .expect(404);
    });

    it('ignores renterId from a renter (always acts as themselves)', async () => {
      const p = await property();
      const res = await api(app, renter)
        .post('/tenancy-interests', {
          propertyId: p.id,
          renterId: otherRenter.id,
        })
        .expect(201);
      expect(res.body.renterId).toBe(renter.id);
    });

    it('requires renterId from a landlord, and a real renter', async () => {
      const p = await property();
      await api(app, landlord)
        .post('/tenancy-interests', { propertyId: p.id })
        .expect(400);
      await api(app, landlord)
        .post('/tenancy-interests', {
          propertyId: p.id,
          renterId: otherLandlord.id,
        })
        .expect(400);
    });

    it("denies a landlord acting on another landlord's property (404)", async () => {
      const p = await property();
      await api(app, otherLandlord)
        .post('/tenancy-interests', { propertyId: p.id, renterId: renter.id })
        .expect(404);
    });

    it('validates the body', async () => {
      await api(app, renter)
        .post('/tenancy-interests', { propertyId: 'nope' })
        .expect(400);
      await api(app, renter).post('/tenancy-interests', {}).expect(400);
    });
  });

  describe('cross-user reads', () => {
    it('hides a row from everyone but its two parties', async () => {
      const p = await property();
      const interest = await renterInterest(renter, p.id);

      await api(app, renter)
        .get(`/tenancy-interests/${interest.id}`)
        .expect(200);
      await api(app, landlord)
        .get(`/tenancy-interests/${interest.id}`)
        .expect(200);
      await api(app, otherRenter)
        .get(`/tenancy-interests/${interest.id}`)
        .expect(404);
      await api(app, otherLandlord)
        .get(`/tenancy-interests/${interest.id}`)
        .expect(404);

      const others = await api(app, otherRenter)
        .get('/tenancy-interests/me')
        .expect(200);
      expect((others.body as TenancyInterest[]).map((i) => i.id)).not.toContain(
        interest.id,
      );

      await api(app, otherLandlord)
        .get(`/properties/${p.id}/tenancy-interests`)
        .expect(404);
      await api(app, renter)
        .get(`/properties/${p.id}/tenancy-interests`)
        .expect(404);
    });

    it('gives the landlord an Applicants list (pending by default)', async () => {
      const p = await property();
      const interest = await renterInterest(renter, p.id);
      const res = await api(app, landlord)
        .get(`/properties/${p.id}/tenancy-interests`)
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        id: interest.id,
        status: 'pending',
        viewerSide: 'landlord',
        counterparty: { displayName: renter.displayName },
      });
      expect(res.body[0].property).not.toHaveProperty('title');
    });

    it('validates ids and filters', async () => {
      await api(app, renter).get('/tenancy-interests/not-a-uuid').expect(400);
      await api(app, landlord)
        .get('/properties/not-a-uuid/tenancy-interests')
        .expect(400);
      await api(app, renter)
        .get('/tenancy-interests/me?status=withdrawn')
        .expect(400);
      await api(app, renter)
        .post('/tenancy-interests/not-a-uuid/decline')
        .expect(400);
    });
  });

  describe('declining is silent to the other side', () => {
    it('landlord decline: visible to the landlord, invisible to the renter', async () => {
      const p = await property();
      const interest = await renterInterest(otherRenter, p.id);
      const declined = await api(app, landlord)
        .post(`/tenancy-interests/${interest.id}/decline`)
        .expect(200);
      expect(declined.body.status).toBe('declined');
      expect(declined.body).not.toHaveProperty('declinedBy');

      // Landlord (the decliner) still sees it.
      await api(app, landlord)
        .get(`/tenancy-interests/${interest.id}`)
        .expect(200);
      const landlordDeclined = await api(app, landlord)
        .get(`/properties/${p.id}/tenancy-interests?status=declined`)
        .expect(200);
      expect(
        (landlordDeclined.body as TenancyInterest[]).map((i) => i.id),
      ).toEqual([interest.id]);

      // Renter: gone, from every read path.
      await api(app, otherRenter)
        .get(`/tenancy-interests/${interest.id}`)
        .expect(404);
      for (const query of ['', '?status=declined', '?status=pending']) {
        const res = await api(app, otherRenter)
          .get(`/tenancy-interests/me${query}`)
          .expect(200);
        expect((res.body as TenancyInterest[]).map((i) => i.id)).not.toContain(
          interest.id,
        );
      }
      await api(app, otherRenter)
        .post(`/tenancy-interests/${interest.id}/decline`)
        .expect(404);

      // Re-expressing interest gets the same generic 409 either side.
      const renterRetry = await api(app, otherRenter)
        .post('/tenancy-interests', { propertyId: p.id })
        .expect(409);
      const landlordRetry = await api(app, landlord)
        .post('/tenancy-interests', {
          propertyId: p.id,
          renterId: otherRenter.id,
        })
        .expect(409);
      expect(renterRetry.body.message).toBe(landlordRetry.body.message);
    });

    it('renter decline: visible to the renter, invisible to the landlord', async () => {
      const p = await property();
      const interest = await renterInterest(renter, p.id);
      await api(app, renter)
        .post(`/tenancy-interests/${interest.id}/decline`)
        .expect(200);

      const mine = await api(app, renter)
        .get('/tenancy-interests/me?status=declined')
        .expect(200);
      expect((mine.body as TenancyInterest[]).map((i) => i.id)).toContain(
        interest.id,
      );
      const defaultList = await api(app, renter)
        .get('/tenancy-interests/me')
        .expect(200);
      expect(
        (defaultList.body as TenancyInterest[]).map((i) => i.id),
      ).not.toContain(interest.id);

      await api(app, landlord)
        .get(`/tenancy-interests/${interest.id}`)
        .expect(404);
      const applicants = await api(app, landlord)
        .get(`/properties/${p.id}/tenancy-interests?status=declined`)
        .expect(200);
      expect(applicants.body).toEqual([]);
      await api(app, landlord)
        .post('/tenancy-interests', { propertyId: p.id, renterId: renter.id })
        .expect(409);
    });

    it('a matched pairing can still be declined, once', async () => {
      const p = await property();
      const interest = await renterInterest(renter, p.id);
      await api(app, landlord)
        .post('/tenancy-interests', { propertyId: p.id, renterId: renter.id })
        .expect(201);
      await api(app, renter)
        .post(`/tenancy-interests/${interest.id}/decline`)
        .expect(200);
      await api(app, renter)
        .post(`/tenancy-interests/${interest.id}/decline`)
        .expect(404);
    });

    it("an outsider can't decline someone else's row", async () => {
      const p = await property();
      const interest = await renterInterest(renter, p.id);
      await api(app, otherRenter)
        .post(`/tenancy-interests/${interest.id}/decline`)
        .expect(404);
      await api(app, otherLandlord)
        .post(`/tenancy-interests/${interest.id}/decline`)
        .expect(404);
      const res = await api(app, renter)
        .get(`/tenancy-interests/${interest.id}`)
        .expect(200);
      expect(res.body.status).toBe('pending');
    });

    it('keeps the row (property: null, landlord name kept) when a renter can no longer see the property', async () => {
      const p = await property();
      const interest = await renterInterest(renter, p.id);
      await api(app, landlord).post(`/properties/${p.id}/archive`).expect(200);
      const res = await api(app, renter)
        .get(`/tenancy-interests/${interest.id}`)
        .expect(200);
      expect(res.body).toMatchObject({
        property: null,
        counterparty: { displayName: landlord.displayName },
      });
    });
  });

  // The write-rules trigger, hit directly as app_user so the API's own
  // checks can't mask a gap in it.
  describe('write-rules trigger (direct SQL as app_user)', () => {
    let propertyId: string;
    let interestId: string;

    beforeEach(async () => {
      propertyId = (await property()).id;
      interestId = (await renterInterest(renter, propertyId)).id;
    });

    const update = (user: TestUser, set: string, params: unknown[] = []) =>
      db.outcome(user.id, `UPDATE tenancy_interests SET ${set} WHERE id = $1`, [
        interestId,
        ...params,
      ]);

    it("renter can't set the landlord's column, or rewrite their own", async () => {
      expect(await update(renter, 'landlord_interested_at = now()')).toBe(
        '23514',
      );
      expect(
        await update(renter, "renter_interested_at = now() - interval '1 day'"),
      ).toBe('23514');
      expect(await update(renter, 'renter_interested_at = NULL')).toBe('23514');
    });

    it("landlord can't set the renter's column", async () => {
      expect(await update(landlord, 'renter_interested_at = now()')).toBe(
        '23514',
      );
      expect(await update(landlord, 'landlord_interested_at = now()')).toBe(
        'ok:1',
      );
    });

    it('status only moves through legal transitions, by the right side', async () => {
      expect(await update(renter, "status = 'matched'")).toBe('23514');
      expect(
        await update(renter, "status = 'matched', matched_at = now()"),
      ).toBe('23514');
      expect(await update(renter, "status = 'withdrawn'")).toBe('23514');
      expect(
        await update(renter, "status = 'declined', declined_by = 'landlord'"),
      ).toBe('23514');
      expect(await update(renter, "status = 'declined'")).toBe('23514'); // declined_by missing
      expect(await update(renter, "declined_by = 'renter'")).toBe('23514'); // without status
      expect(
        await update(renter, "status = 'declined', declined_by = 'renter'"),
      ).toBe('ok:1');
    });

    it('nothing leaves declined', async () => {
      await api(app, renter)
        .post(`/tenancy-interests/${interestId}/decline`)
        .expect(200);
      expect(
        await update(renter, "status = 'pending', declined_by = NULL"),
      ).toBe('23514');
    });

    it('identity columns are immutable', async () => {
      expect(
        await update(renter, 'renter_id = $2', [otherRenter.id]),
      ).not.toMatch(/^ok/);
      expect(await update(landlord, 'created_at = now()')).toBe('23514');
    });

    it("outsiders can't update at all", async () => {
      expect(
        await update(
          otherRenter,
          "status = 'declined', declined_by = 'renter'",
        ),
      ).toBe('ok:0');
      expect(
        await update(otherLandlord, 'landlord_interested_at = now()'),
      ).toBe('ok:0');
    });

    it('INSERT: own column only, pending only, published property only', async () => {
      const fresh = (await property()).id;
      const draft = (await property(false)).id;
      const insert = (cols: string, vals: string) =>
        `INSERT INTO tenancy_interests (renter_id, property_id, ${cols}) VALUES ($1, $2, ${vals})`;

      expect(
        await db.outcome(
          otherRenter.id,
          insert('landlord_interested_at', 'now()'),
          [otherRenter.id, fresh],
        ),
      ).toBe('23514');
      expect(
        await db.outcome(
          otherRenter.id,
          insert('renter_interested_at, status', "now(), 'matched'"),
          [otherRenter.id, fresh],
        ),
      ).toBe('23514');
      expect(
        await db.outcome(
          landlord.id,
          insert('landlord_interested_at', 'now()'),
          [otherRenter.id, draft],
        ),
      ).toBe('23514');
      expect(
        await db.outcome(
          otherRenter.id,
          insert('renter_interested_at', 'now()'),
          [otherRenter.id, fresh],
        ),
      ).toBe('ok:1');
    });
  });
});
