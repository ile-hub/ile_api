import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { Pool } from 'pg';
import { RequestContextService } from '../common/request-context.service';
import {
  AcceptTermsDto,
  AcknowledgePrivacyDto,
  UpdateConsentDto,
} from './privacy.dto';
import { PrivacyService } from './privacy.service';

const documents = [
  {
    id: 'terms-id',
    kind: 'terms',
    version: 'v1',
    content: 'Terms',
    demoOnly: true,
  },
  {
    id: 'notice-id',
    kind: 'privacy_notice',
    version: 'v1',
    content: 'Notice',
    demoOnly: true,
  },
];
describe('Privacy foundations', () => {
  const setup = (docs = documents) => {
    const query = jest.fn((sql: string) => {
      if (sql.includes('DISTINCT ON (kind)'))
        return Promise.resolve({ rows: docs });
      if (sql.startsWith('INSERT INTO leri_consent_events'))
        return Promise.resolve({
          rows: [{ id: 'event', purpose: 'user_research', granted: false }],
        });
      return Promise.resolve({ rows: [] });
    });
    const context = {
      getClient: () => ({ query }),
      getUserId: () => 'owner',
      getRole: () => Promise.resolve('renter'),
    } as unknown as RequestContextService;
    return {
      service: new PrivacyService({ query } as unknown as Pool, context),
      query,
    };
  };
  it('reports missing reviewed legal content instead of inventing it', async () => {
    const { service } = setup([]);
    await expect(service.getDocuments()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
  it('rejects stale document acceptance without writing', async () => {
    const { service, query } = setup();
    await expect(service.acceptTerms('old')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('keeps optional consent independent from accepting terms', async () => {
    const { service, query } = setup();
    await service.acceptTerms('v1');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (user_id, document_id) DO NOTHING'),
      ['owner', 'terms-id'],
    );
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO leri_consent_events'),
      ),
    ).toBe(false);
  });
  it('records withdrawal as a new event attributed to the caller', async () => {
    const { service, query } = setup();
    await service.updateConsent({
      purpose: 'user_research',
      granted: false,
      privacyNoticeVersion: 'v1',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO leri_consent_events'),
      ['owner', 'user_research', false, 'notice-id'],
    );
  });
  it('defaults every unset optional consent to false', async () => {
    const { service } = setup();
    expect((await service.getOwnPrivacy()).consents).toEqual([
      {
        purpose: 'product_updates',
        granted: false,
        privacyNoticeVersion: null,
        recordedAt: null,
      },
      {
        purpose: 'user_research',
        granted: false,
        privacyNoticeVersion: null,
        recordedAt: null,
      },
    ]);
  });
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  it.each([
    [AcceptTermsDto, { termsVersion: 'v1', accepted: false }],
    [AcceptTermsDto, { termsVersion: 'v1', accepted: true, userId: 'other' }],
    [
      AcknowledgePrivacyDto,
      { privacyNoticeVersion: 'v1', acknowledged: false },
    ],
    [
      UpdateConsentDto,
      { purpose: 'mandatory', granted: true, privacyNoticeVersion: 'v1' },
    ],
    [
      UpdateConsentDto,
      {
        purpose: 'user_research',
        granted: 'false',
        privacyNoticeVersion: 'v1',
      },
    ],
  ])('validates legal request payloads', async (metatype, body) => {
    await expect(
      pipe.transform(body, { type: 'body', metatype }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
