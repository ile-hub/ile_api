import { INestApplication } from '@nestjs/common';
import type { EvidenceItem } from '@yourorg/ile-shared-types';
import { App } from 'supertest/types';
import { api, AppUserDb, createApp, createUser, TestUser } from './helpers';

const SUBMISSION = {
  pillar: 'affordability',
  pathwayType: 'payslip',
  payload: { monthlyIncome: 3200 },
};

describe('Evidence (e2e)', () => {
  let app: INestApplication<App>;
  let db: AppUserDb;
  let renter: TestUser;
  let otherRenter: TestUser;
  let landlord: TestUser;

  beforeAll(async () => {
    app = await createApp();
    db = new AppUserDb();
    [renter, otherRenter, landlord] = await Promise.all([
      createUser('renter', 'Renter'),
      createUser('renter', 'Other Renter'),
      createUser('landlord', 'Landlord'),
    ]);
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  async function submit(user = renter): Promise<EvidenceItem> {
    const res = await api(app, user).post('/evidence', SUBMISSION).expect(201);
    return res.body as EvidenceItem;
  }

  it('lets a renter submit, in the shared EvidenceItem shape', async () => {
    expect(await submit()).toEqual({
      id: expect.any(String),
      renterId: renter.id,
      pillar: 'affordability',
      pathwayType: 'payslip',
      payload: { monthlyIncome: 3200 },
      status: 'submitted',
      createdAt: expect.any(String),
    });
  });

  it('rejects a landlord', async () => {
    await api(app, landlord).post('/evidence', SUBMISSION).expect(403);
  });

  it.each([
    ['unknown pillar', { pillar: 'character' }],
    ['missing pathwayType', { pathwayType: undefined }],
    ['non-object payload', { payload: 'x' }],
    ['client-supplied status', { status: 'verified' }],
  ])('rejects %s', async (_label, override) => {
    await api(app, renter)
      .post('/evidence', { ...SUBMISSION, ...override })
      .expect(400);
  });

  it("lists and reads only the caller's own items", async () => {
    const mine = await submit();
    const theirs = await submit(otherRenter);

    const list = await api(app, renter).get('/evidence').expect(200);
    const ids = (list.body as EvidenceItem[]).map((e) => e.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);

    await api(app, renter).get(`/evidence/${theirs.id}`).expect(404);
    await api(app, landlord).get(`/evidence/${mine.id}`).expect(404);
    await api(app, renter).get('/evidence/not-a-uuid').expect(400);
  });

  it('withdraws once, and only the owner can', async () => {
    const item = await submit();
    await api(app, otherRenter)
      .post(`/evidence/${item.id}/withdraw`)
      .expect(404);
    const res = await api(app, renter)
      .post(`/evidence/${item.id}/withdraw`)
      .expect(200);
    expect(res.body.status).toBe('withdrawn');
    await api(app, renter).post(`/evidence/${item.id}/withdraw`).expect(404);
  });

  it('RLS: no cross-renter reads or writes, even with direct SQL', async () => {
    const item = await submit();
    expect(
      await db.outcome(
        otherRenter.id,
        'SELECT 1 FROM evidence_items WHERE id = $1',
        [item.id],
      ),
    ).toBe('ok:0');
    expect(
      await db.outcome(
        otherRenter.id,
        "UPDATE evidence_items SET status = 'withdrawn' WHERE id = $1",
        [item.id],
      ),
    ).toBe('ok:0');
    expect(
      await db.outcome(
        renter.id,
        "UPDATE evidence_items SET status = 'verified' WHERE id = $1",
        [item.id],
      ),
    ).toBe('23514');
  });
});
