import sharp from 'sharp';
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

describe('Person connections and accepted-only messaging with real Supabase', () => {
  let app: INestApplication<App>, db: AppUserDb;
  let renter: TestUser,
    landlord: TestUser,
    outsider: TestUser,
    otherLandlord: TestUser;
  let id: string;
  beforeAll(async () => {
    app = await createApp();
    db = new AppUserDb();
    renter = await createUser('renter', 'Connection renter');
    landlord = await createUser('landlord', 'Connection landlord');
    outsider = await createUser('renter', 'Outside renter');
    otherLandlord = await createUser('landlord', 'Other connection landlord');
    for (const user of [renter, landlord, outsider, otherLandlord])
      await api(app, user)
        .patch('/me/profile', { discoverable: true })
        .expect(200);
    await api(app, renter)
      .patch('/me/profile', { currentLocation: 'PRIVATE CONNECTION LOCATION' })
      .expect(200);
  });
  afterAll(async () => {
    await db?.end();
    await app?.close();
  });
  it('requires real authentication and strictly validates introduction/recipient', async () => {
    await request(app.getHttpServer()).get('/connections').expect(401);
    for (const introduction of ['', '   ', 'a'.repeat(3001), null])
      await api(app, renter)
        .post('/connections', { recipientId: landlord.id, introduction })
        .expect(400);
    await api(app, renter)
      .post('/connections', {
        recipientId: landlord.id,
        introduction: 'Hello',
        trustScore: 100,
      })
      .expect(400);
    await api(app, renter)
      .post('/connections', { recipientId: 'bad', introduction: 'Hello' })
      .expect(400);
    await api(app, renter)
      .post('/connections', { recipientId: renter.id, introduction: 'Hello' })
      .expect(403);
    await api(app, renter)
      .post('/connections', { recipientId: outsider.id, introduction: 'Hello' })
      .expect(404);
    await api(app, renter)
      .post('/connections', {
        recipientId: randomUUID(),
        introduction: 'Hello',
      })
      .expect(404);
  });
  it('requires both people to opt in to public profiles', async () => {
    await api(app, renter)
      .patch('/me/profile', { discoverable: false })
      .expect(200);
    await api(app, renter)
      .post('/connections', { recipientId: landlord.id, introduction: 'Hello' })
      .expect(403);
    await api(app, renter)
      .patch('/me/profile', { discoverable: true })
      .expect(200);
    await api(app, landlord)
      .patch('/me/profile', { discoverable: false })
      .expect(200);
    await api(app, renter)
      .post('/connections', { recipientId: landlord.id, introduction: 'Hello' })
      .expect(404);
    await api(app, landlord)
      .patch('/me/profile', { discoverable: true })
      .expect(200);
  });
  it('creates a person request with a personalised note and no property application', async () => {
    const response = await api(app, renter)
      .post('/connections', {
        recipientId: landlord.id,
        introduction: '  I liked your approach to communication.  ',
      })
      .expect(201);
    id = response.body.id as string;
    expect(response.body.status).toBe('pending');
    expect(response.body.conversationId).toBeNull();
    expect(response.body.introduction).toBe(
      'I liked your approach to communication.',
    );
    expect(response.body.direction).toBe('outgoing');
    const incoming = await api(app, landlord)
      .get('/connections?direction=incoming&status=pending')
      .expect(200);
    expect(
      (incoming.body.items as { id: string }[]).some((x) => x.id === id),
    ).toBe(true);
    expect(JSON.stringify(incoming.body)).not.toContain(
      'PRIVATE CONNECTION LOCATION',
    );
    expect(JSON.stringify(incoming.body)).not.toContain('"email"');
  });
  it('prevents same-pair duplicate or reciprocal auto-acceptance', async () => {
    await api(app, renter)
      .post('/connections', { recipientId: landlord.id, introduction: 'Again' })
      .expect(409);
    await api(app, landlord)
      .post('/connections', {
        recipientId: renter.id,
        introduction: 'Reciprocal',
      })
      .expect(409);
    expect((await api(app, renter).get('/connections/' + id)).body.status).toBe(
      'pending',
    );
  });
  it('sender and nonparticipants cannot decide, and pending chat is locked', async () => {
    for (const action of ['accept', 'decline', 'review-later']) {
      await api(app, renter).post(`/connections/${id}/${action}`).expect(403);
      await api(app, outsider).post(`/connections/${id}/${action}`).expect(404);
    }
    await api(app, renter).get(`/connections/${id}/messages`).expect(409);
    await api(app, renter)
      .post(`/connections/${id}/messages`, { text: 'Too soon' })
      .expect(409);
    expect(
      await db.outcome(
        renter.id,
        "UPDATE leri_connections SET status='accepted' WHERE id=$1",
        [id],
      ),
    ).toBe('ok:0');
    expect(
      await db.outcome(
        renter.id,
        'INSERT INTO leri_messages(connection_id,sender_id,body) VALUES($1,$2,$3)',
        [id, renter.id, 'Too soon'],
      ),
    ).toBe('42501');
  });
  it('review later is explicit, visible to sender and does not unlock chat', async () => {
    await api(app, landlord)
      .post(`/connections/${id}/review-later`)
      .expect(200);
    expect((await api(app, renter).get('/connections/' + id)).body.status).toBe(
      'review_later',
    );
    await api(app, landlord).get(`/connections/${id}/messages`).expect(409);
  });
  it('recipient acceptance atomically opens exactly one conversation; retries are idempotent', async () => {
    const accepted = await api(app, landlord)
      .post(`/connections/${id}/accept`)
      .expect(200);
    expect(accepted.body.status).toBe('accepted');
    expect(accepted.body.conversationId).toBe(id);
    expect(accepted.body.acceptedAt).toBeTruthy();
    const repeat = await api(app, landlord)
      .post(`/connections/${id}/accept`)
      .expect(200);
    expect(repeat.body.acceptedAt).toBe(accepted.body.acceptedAt);
    await api(app, landlord).post(`/connections/${id}/decline`).expect(409);
    await api(app, landlord)
      .post(`/connections/${id}/review-later`)
      .expect(409);
  });
  it('only accepted participants can send plain-text messages and read stable chronological pages', async () => {
    const first = await api(app, renter)
      .post(`/connections/${id}/messages`, {
        text: ' Hello, thank you for connecting. ',
      })
      .expect(201);
    const second = await api(app, landlord)
      .post(`/connections/${id}/messages`, {
        text: 'Let’s discuss your move date.',
      })
      .expect(201);
    expect(first.body.senderId).toBe(renter.id);
    expect(first.body.text).toBe('Hello, thank you for connecting.');
    const page = await api(app, renter)
      .get(`/connections/${id}/messages?limit=1`)
      .expect(200);
    expect(page.body.items[0].id).toBe(first.body.id);
    expect(page.body.nextCursor).toBe(first.body.cursor);
    const next = await api(app, landlord)
      .get(`/connections/${id}/messages?after=${page.body.nextCursor}`)
      .expect(200);
    expect(next.body.items[0].id).toBe(second.body.id);
    await api(app, outsider).get(`/connections/${id}/messages`).expect(404);
    await api(app, outsider)
      .post(`/connections/${id}/messages`, { text: 'Intrusion' })
      .expect(404);
  });
  it('retains concurrent sends in cursor order for both participants', async () => {
    const previous = await api(app, renter)
      .get(`/connections/${id}/messages`)
      .expect(200);
    const history = previous.body.items as { cursor: string }[];
    const after = history.at(-1)!.cursor;
    const sends = await Promise.all([
      api(app, renter).post(`/connections/${id}/messages`, {
        text: 'Concurrent introduction',
      }),
      api(app, landlord).post(`/connections/${id}/messages`, {
        text: 'Concurrent response',
      }),
    ]);
    expect(sends.map((result) => result.status)).toEqual([201, 201]);
    const page = await api(app, renter)
      .get(`/connections/${id}/messages?after=${after}`)
      .expect(200);
    const messages = page.body.items as { cursor: string }[];
    expect(messages).toHaveLength(2);
    expect(BigInt(messages[0].cursor) < BigInt(messages[1].cursor)).toBe(true);
  });
  it('validates messages and pagination, disallowing sender spoofing', async () => {
    for (const text of ['', ' ', null, 'x'.repeat(4001)])
      await api(app, renter)
        .post(`/connections/${id}/messages`, { text })
        .expect(400);
    await api(app, renter)
      .post(`/connections/${id}/messages`, {
        text: 'Hello',
        senderId: landlord.id,
      })
      .expect(400);
    await api(app, renter)
      .get(`/connections/${id}/messages?after=-1`)
      .expect(400);
    await api(app, renter).get('/connections?direction=everyone').expect(400);
    await api(app, renter).get('/connections?status=matched').expect(400);
  });
  it('enforces message/request privacy and immutable history through direct app_user RLS', async () => {
    expect(
      await db.outcome(
        outsider.id,
        'SELECT * FROM leri_connections WHERE id=$1',
        [id],
      ),
    ).toBe('ok:0');
    expect(
      await db.outcome(
        outsider.id,
        'SELECT * FROM leri_messages WHERE connection_id=$1',
        [id],
      ),
    ).toBe('ok:0');
    expect(
      await db.outcome(
        outsider.id,
        'INSERT INTO leri_messages(connection_id,sender_id,body) VALUES($1,$2,$3)',
        [id, outsider.id, 'Intrusion'],
      ),
    ).toBe('42501');
    expect(
      await db.outcome(
        renter.id,
        'INSERT INTO leri_messages(connection_id,sender_id,body) VALUES($1,$2,$3)',
        [id, landlord.id, 'Spoof'],
      ),
    ).toBe('42501');
    expect(
      await db.outcome(
        landlord.id,
        "UPDATE leri_connections SET introduction='replaced' WHERE id=$1",
        [id],
      ),
    ).toBe('42501');
    expect(
      await db.outcome(
        renter.id,
        "UPDATE leri_messages SET body='replaced' WHERE connection_id=$1",
        [id],
      ),
    ).toBe('42501');
    expect(
      await db.outcome(
        renter.id,
        'DELETE FROM leri_messages WHERE connection_id=$1',
        [id],
      ),
    ).toBe('42501');
    expect(
      await db.outcome(
        renter.id,
        "INSERT INTO leri_connections(sender_id,recipient_id,introduction,status,accepted_at) VALUES($1,$2,$3,'accepted',now())",
        [renter.id, otherLandlord.id, 'Self approval'],
      ),
    ).toBe('23514');
  });
  it('landlords can initiate and declines remain visible to both parties', async () => {
    const response = await api(app, otherLandlord)
      .post('/connections', {
        recipientId: renter.id,
        introduction: 'Would you like to connect?',
      })
      .expect(201);
    await api(app, renter)
      .post(`/connections/${response.body.id}/decline`)
      .expect(200);
    const declined = await api(app, otherLandlord)
      .get(`/connections/${response.body.id}`)
      .expect(200);
    expect(declined.body.status).toBe('declined');
    expect(declined.body.conversationId).toBeNull();
    await api(app, otherLandlord)
      .get(`/connections/${response.body.id}/messages`)
      .expect(409);
    await api(app, renter)
      .post(`/connections/${response.body.id}/accept`)
      .expect(409);
  });
  it('serializes competing decisions without granting conflicting conversation state', async () => {
    const created = await api(app, landlord)
      .post('/connections', {
        recipientId: outsider.id,
        introduction: 'A separate synthetic request',
      })
      .expect(201);
    const responses = await Promise.all([
      api(app, outsider).post(`/connections/${created.body.id}/accept`),
      api(app, outsider).post(`/connections/${created.body.id}/decline`),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const stored = await api(app, landlord)
      .get(`/connections/${created.body.id}`)
      .expect(200);
    expect(['accepted', 'declined']).toContain(stored.body.status);
  });
  it('hiding a profile revokes profile content but does not silently revoke existing accepted communication', async () => {
    await api(app, landlord)
      .patch('/me/profile', { discoverable: false })
      .expect(200);
    const connection = await api(app, renter)
      .get('/connections/' + id)
      .expect(200);
    expect(connection.body.counterparty).toBeNull();
    await api(app, renter)
      .post(`/connections/${id}/messages`, {
        text: 'Existing connection still works.',
      })
      .expect(201);
  });
  it('denies direct Supabase table access to ordinary authenticated sessions', async () => {
    const response = await fetch(
      process.env.SUPABASE_URL + '/rest/v1/leri_messages?select=*',
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${outsider.token}`,
        },
      },
    );
    expect(response.ok).toBe(false);
  });
  it('completes the synthetic story/evidence/property-photo/discovery/request/accept/chat journey', async () => {
    const demoRenter = await createUser('renter', 'Synthetic journey renter');
    const demoLandlord = await createUser(
      'landlord',
      'Synthetic journey landlord',
    );
    await api(app, demoRenter)
      .patch('/me/profile', {
        discoverable: true,
        bio: 'Synthetic renter seeking a home in Edinburgh.',
        personalStory: 'I care for shared spaces and communicate early.',
        preferredLocation: 'Edinburgh',
        budgetMax: 1600,
      })
      .expect(200);
    await api(app, demoLandlord)
      .patch('/me/profile', {
        discoverable: true,
        bio: 'Synthetic landlord who values clear communication.',
        tenantExpectations:
          'Responsive communication and well-maintained homes.',
      })
      .expect(200);
    const catalogue = await api(app, demoRenter)
      .get('/evidence/catalogue')
      .expect(200);
    const options = (catalogue.body as { id: string; pillar: string }[])
      .filter((x) => x.pillar === 'affordability')
      .slice(0, 2);
    const choices: string[] = [];
    for (const option of options) {
      const evidence = await api(app, demoRenter)
        .post('/evidence', {
          pillar: 'affordability',
          catalogueId: option.id,
          explanation: 'PRIVATE SYNTHETIC EXPLANATION',
        })
        .expect(201);
      choices.push(evidence.body.id as string);
    }
    await request(app.getHttpServer())
      .post(`/evidence/${choices[0]}/documents`)
      .set('Authorization', `Bearer ${demoRenter.token}`)
      .attach(
        'file',
        Buffer.from('%PDF-1.4\nSynthetic private demo evidence\n%%EOF'),
        {
          filename: 'synthetic-private-evidence.pdf',
          contentType: 'application/pdf',
        },
      )
      .expect(201);
    await request(app.getHttpServer())
      .put('/landlords/me/arcs-preferences')
      .set('Authorization', `Bearer ${demoLandlord.token}`)
      .send({
        priorityOrder: [
          'stability',
          'community',
          'reliability',
          'affordability',
        ],
        evidencePreferences: {
          [options[0].id]: 'prefer',
          [options[1].id]: 'accept',
        },
      })
      .expect(200);
    const photo = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#DCE8D3' },
    })
      .png()
      .toBuffer();
    const propertyIds: string[] = [];
    for (let index = 0; index < 2; index++) {
      const created = await api(app, demoLandlord)
        .post('/properties', {
          ...VALID_PROPERTY,
          title: `Synthetic demo home ${index + 1}`,
          details: {
            privateReference: 'PRIVATE JOURNEY REFERENCE',
            publicArea: 'Central Edinburgh',
            postcodeDistrict: 'EH1',
            depositAmount: 1500,
            availableFrom: '2026-11-01',
            minTenancyMonths: 6,
            expectedTenancyMonths: 12,
            propertyType: 'flat',
            bathrooms: 1,
            permittedOccupants: 2,
            furnishing: 'furnished',
            councilTaxBand: 'D',
            epcRating: 'C',
            hmoLicenceStatus: 'not_required',
            registrationNumbers: ['SYNTHETIC-DEMO-ONLY'],
          },
        })
        .expect(201);
      propertyIds.push(created.body.id as string);
      await request(app.getHttpServer())
        .post(`/properties/${created.body.id}/photos`)
        .set('Authorization', `Bearer ${demoLandlord.token}`)
        .attach('file', photo, {
          filename: 'synthetic-room.png',
          contentType: 'image/png',
        })
        .expect(201);
      await api(app, demoLandlord)
        .post(`/properties/${created.body.id}/publish`)
        .expect(200);
    }
    let found = false,
      cursor: string | null = null;
    do {
      const page = await api(app, demoRenter)
        .get(
          `/discovery?mode=suggested&limit=50${cursor ? '&after=' + cursor : ''}`,
        )
        .expect(200);
      found = (page.body.items as { profile: { id: string } }[]).some(
        (x) => x.profile.id === demoLandlord.id,
      );
      cursor = page.body.nextCursor as string | null;
    } while (!found && cursor);
    expect(found).toBe(true);
    const profile = await api(app, demoRenter)
      .get(`/profiles/${demoLandlord.id}`)
      .expect(200);
    expect(profile.body.properties).toHaveLength(2);
    const detail = await api(app, demoRenter)
      .get(`/landlords/${demoLandlord.id}/properties/${propertyIds[0]}`)
      .expect(200);
    expect(detail.body.photos).toHaveLength(1);
    expect(JSON.stringify(detail.body)).not.toContain(
      'PRIVATE JOURNEY REFERENCE',
    );
    expect(JSON.stringify(detail.body)).not.toContain(
      VALID_PROPERTY.addressLine1,
    );
    const download = await api(app, demoRenter)
      .get(
        `/landlords/${demoLandlord.id}/properties/${propertyIds[0]}/photos/${detail.body.photos[0].id}/download`,
      )
      .expect(200);
    expect((await fetch(download.body.url as string)).ok).toBe(true);
    const publicRenter = await api(app, demoLandlord)
      .get(`/profiles/${demoRenter.id}`)
      .expect(200);
    expect(JSON.stringify(publicRenter.body)).toContain('Document uploaded');
    expect(JSON.stringify(publicRenter.body)).not.toContain(
      'PRIVATE SYNTHETIC EXPLANATION',
    );
    expect(JSON.stringify(publicRenter.body)).not.toContain(
      'synthetic-private-evidence.pdf',
    );
    const created = await api(app, demoRenter)
      .post('/connections', {
        recipientId: demoLandlord.id,
        introduction:
          'I liked your communication approach and the Edinburgh homes in your profile.',
      })
      .expect(201);
    const connectionId = created.body.id as string;
    await api(app, demoRenter)
      .post(`/connections/${connectionId}/messages`, {
        text: 'Not accepted yet',
      })
      .expect(409);
    await api(app, demoLandlord)
      .post(`/connections/${connectionId}/accept`)
      .expect(200);
    await api(app, demoRenter)
      .post(`/connections/${connectionId}/messages`, {
        text: 'Thank you for connecting. Can we discuss a viewing?',
      })
      .expect(201);
    const messages = await api(app, demoLandlord)
      .get(`/connections/${connectionId}/messages`)
      .expect(200);
    expect(messages.body.items).toHaveLength(1);
  });
});
