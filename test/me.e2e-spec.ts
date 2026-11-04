import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { api, createApp, createUser } from './helpers';

describe('GET /me (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a renter with their profile summary', async () => {
    const renter = await createUser('renter', 'Renter');
    const res = await api(app, renter).get('/me').expect(200);
    expect(res.body).toEqual({
      id: renter.id,
      email: renter.email,
      role: 'renter',
      displayName: renter.displayName,
      profile: {
        kind: 'renter',
        bio: null,
        institutionId: null,
        createdAt: expect.any(String),
      },
    });
  });

  it('returns a landlord with their verification status', async () => {
    const landlord = await createUser('landlord', 'Landlord');
    const res = await api(app, landlord).get('/me').expect(200);
    expect(res.body).toEqual({
      id: landlord.id,
      email: landlord.email,
      role: 'landlord',
      displayName: landlord.displayName,
      profile: {
        kind: 'landlord',
        companyName: null,
        verificationStatus: 'unverified',
        createdAt: expect.any(String),
      },
    });
  });

  it('requires a valid session', async () => {
    await request(app.getHttpServer()).get('/me').expect(401);
  });
});
