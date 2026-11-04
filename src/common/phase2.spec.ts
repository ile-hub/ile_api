import sharp from 'sharp';
import {
  BadRequestException,
  ExecutionContext,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { firstValueFrom, from } from 'rxjs';
import { ArcsPreferencesDto } from '../landlords/arcs-preferences.dto';
import { PropertyDetailsDto } from '../properties/dto/property-details.dto';
import {
  checkPropertyDetails,
  mergePropertyDetails,
} from '../properties/properties.service';
import { SubmitEvidenceDto } from '../evidence/dto/submit-evidence.dto';
import {
  PrivateStorageService,
  validateAsset,
  preparePropertyPhoto,
  EVIDENCE_BUCKET,
  FILE_LIMIT,
  UploadedAsset,
} from './private-storage.service';
import { RequestContextService } from './request-context.service';
import { RlsTransactionInterceptor } from './rls-transaction.interceptor';
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const pdf = Buffer.from('%PDF-1.4\nSynthetic dummy\n%%EOF');
const asset = (buffer = pdf, mimetype = 'application/pdf'): UploadedAsset => ({
  buffer,
  size: buffer.length,
  mimetype,
  originalname: 'dummy.pdf',
});
describe('Phase 2 validation', () => {
  it('accepts catalogue-based evidence without private payload', async () => {
    await expect(
      pipe.transform(
        {
          pillar: 'affordability',
          catalogueId: 'affordability.savings',
          explanation: 'Dummy',
        },
        { type: 'body', metatype: SubmitEvidenceDto },
      ),
    ).resolves.toBeInstanceOf(SubmitEvidenceDto);
  });
  it.each([
    {
      priorityOrder: [
        'affordability',
        'affordability',
        'community',
        'stability',
      ],
      evidencePreferences: {},
    },
    {
      priorityOrder: ['affordability', 'reliability', 'community'],
      evidencePreferences: {},
    },
    {
      priorityOrder: ['affordability', 'reliability', 'community', 'stability'],
      evidencePreferences: [],
      score: 99,
    },
  ])('rejects malformed rankings %j', async (body) => {
    await expect(
      pipe.transform(body, { type: 'body', metatype: ArcsPreferencesDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it.each([
    { depositAmount: -1 },
    { permittedOccupants: 0 },
    { postcodeDistrict: 'EH1 1AA' },
    { billsIncluded: null },
    { registrationNumbers: null },
    { walkthroughUrl: 'http://example.com/video' },
    { secret: 'not allowed' },
  ])('rejects invalid property details %j', async (body) => {
    await expect(
      pipe.transform(body, { type: 'body', metatype: PropertyDetailsDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it.each([
    { billsIncluded: ['gas'], billsExcluded: ['gas'] },
    { minTenancyMonths: 12, expectedTenancyMonths: 6 },
    { hmoLicenceStatus: 'licensed' },
    { walkthroughType: 'video' },
    { registrationNumbers: ['  '] },
  ])('rejects inconsistent merged details %j', (body) => {
    expect(() => checkPropertyDetails(body as PropertyDetailsDto)).toThrow(
      BadRequestException,
    );
  });
  it('merges transformed partial details without replacing saved fields with undefined', () => {
    const patch = new PropertyDetailsDto();
    patch.minTenancyMonths = 24;
    expect(() =>
      mergePropertyDetails(
        { minTenancyMonths: 6, expectedTenancyMonths: 12 },
        patch,
      ),
    ).toThrow(BadRequestException);
    const valid = new PropertyDetailsDto();
    valid.parking = 'Off-street';
    expect(
      mergePropertyDetails(
        {
          minTenancyMonths: 6,
          expectedTenancyMonths: 12,
          privateReference: 'private',
        },
        valid,
      ),
    ).toMatchObject({
      minTenancyMonths: 6,
      expectedTenancyMonths: 12,
      privateReference: 'private',
      parking: 'Off-street',
    });
  });
  it('accepts PDF evidence but rejects PDF property photos', () => {
    expect(validateAsset(asset())).toBeDefined();
    expect(() => validateAsset(asset(), true)).toThrow(BadRequestException);
  });
  it.each([
    asset(Buffer.from('<svg>bad</svg>'), 'image/png'),
    asset(Buffer.from('%PDF-1.4 missing end'), 'application/pdf'),
    asset(Buffer.alloc(FILE_LIMIT + 1)),
    asset(Buffer.alloc(0)),
    { ...asset(), size: 1 },
  ])('rejects empty, spoofed or oversized uploads', (file) => {
    expect(() => validateAsset(file)).toThrow(BadRequestException);
  });
  it('strips private EXIF metadata from public gallery photos', async () => {
    const input = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .withExif({ IFD0: { ImageDescription: 'PRIVATE LOCATION' } })
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const result = await preparePropertyPhoto(asset(input, 'image/jpeg'));
    expect((await sharp(result.buffer).metadata()).exif).toBeUndefined();
    expect(result.buffer.includes(Buffer.from('PRIVATE LOCATION'))).toBe(false);
  });
  it('rejects corrupt image data even with a valid MIME signature', async () => {
    await expect(
      preparePropertyPhoto(
        asset(Buffer.from([255, 216, 255, 0]), 'image/jpeg'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('compensates a remote upload if database COMMIT fails', async () => {
    const context = new RequestContextService();
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response('{}', { status: 200 })),
      );
    const release = jest.fn();
    const client = {
      query: jest.fn((sql: string) =>
        sql === 'COMMIT'
          ? Promise.reject(new Error('commit failure'))
          : Promise.resolve({ rows: [] }),
      ),
      release,
    } as unknown as PoolClient;
    const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
    const storage = new PrivateStorageService(
      new ConfigService({
        SUPABASE_URL: 'http://127.0.0.1:55321',
        SUPABASE_ANON_KEY: 'local-anon',
      }),
      context,
    );
    const interceptor = new RlsTransactionInterceptor(pool, context, {
      activateTransaction: () => Promise.resolve(),
    } as never);
    const execution = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: { id: 'owner' },
          headers: { authorization: 'Bearer local-session' },
        }),
      }),
    } as unknown as ExecutionContext;
    try {
      await expect(
        firstValueFrom(
          interceptor.intercept(execution, {
            handle: () =>
              from(
                storage
                  .upload(EVIDENCE_BUCKET, 'owner/evidence/item/file', asset())
                  .then(() => ({ uploaded: true })),
              ),
          }),
        ),
      ).rejects.toThrow('commit failure');
      expect(
        fetchMock.mock.calls.map(([, options]) => options?.method),
      ).toEqual(['POST', 'DELETE']);
      expect(release).toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });
});
