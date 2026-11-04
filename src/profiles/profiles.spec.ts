import {
  BadRequestException,
  ForbiddenException,
  ValidationPipe,
} from '@nestjs/common';
import { RequestContextService } from '../common/request-context.service';
import { UpdateProfileDto } from './profile.dto';
import { ProfilesService } from './profiles.service';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (body: object) =>
  pipe.transform(body, { type: 'body', metatype: UpdateProfileDto });

describe('Profile validation and authorisation', () => {
  it.each([
    { verificationStatus: 'verified' },
    { identityStatus: 'verified' },
    { isDemo: true },
    { photoVerificationStatus: 'verified' },
    { userId: 'somebody-else' },
    { email: 'x@example.com' },
    { displayName: null },
    { householdSize: 0 },
    { budgetMin: -1 },
    { tenancyLengthMonths: 0 },
    { landlordType: 'other' },
    { householdPreferences: ['ethnicity'] },
    { locationsCovered: null },
    { registrationNumbers: null },
    { discoverable: null },
    { photoUrl: 'http://example.com/me.jpg' },
    { photoUrl: 'https://secret:password@example.com/me.jpg' },
    { targetMoveDate: '2026-02-30' },
  ])('rejects invalid or protected input %j', async (body) => {
    await expect(validate(body)).rejects.toBeInstanceOf(BadRequestException);
  });
  it('accepts nullable optional prompts and multiple registration numbers', async () => {
    await expect(
      validate({
        personalStory: null,
        registrationNumbers: ['123/456/789', '987/654/321'],
      }),
    ).resolves.toBeInstanceOf(UpdateProfileDto);
  });
  const setup = (
    role = 'renter',
    stored = { budget_min: '100', budget_max: '1000' },
  ) => {
    const query = jest.fn((sql: string) => {
      if (sql.includes('FOR UPDATE'))
        return Promise.resolve({ rowCount: 1, rows: [{ user_id: 'me' }] });
      if (sql.includes('SELECT budget_min'))
        return Promise.resolve({ rows: [stored] });
      return Promise.resolve({ rows: [{ profile: { id: 'me' } }] });
    });
    const context = {
      getRole: () => Promise.resolve(role),
      getClient: () => ({ query }),
      getUserId: () => 'me',
    } as unknown as RequestContextService;
    return {
      service: new ProfilesService(context, {
        decorate: (p: unknown) => Promise.resolve(p),
      } as never),
      query,
    };
  };
  it('rejects role-inappropriate fields before any write', async () => {
    const { service, query } = setup();
    await expect(
      service.update({ registrationNumbers: ['123'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects platform roles before accessing profiles', async () => {
    const { service, query } = setup('platform_admin');
    await expect(service.getOwn()).rejects.toBeInstanceOf(ForbiddenException);
    expect(query).not.toHaveBeenCalled();
  });
  it('checks a partial budget change against the saved other bound', async () => {
    const { service, query } = setup();
    await expect(service.update({ budgetMin: 1001 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(
      query.mock.calls.every(
        ([sql]) => !sql.startsWith('UPDATE') && !sql.startsWith('INSERT'),
      ),
    ).toBe(true);
  });
  it('keeps property updates scoped to the session profile and preferences', async () => {
    const { service, query } = setup();
    await service.update({ personalStory: 'My story', budgetMax: 1500 });
    const writes = query.mock.calls.filter(([sql]) =>
      /^(UPDATE|INSERT)/.test(sql),
    );
    expect(writes).toHaveLength(2);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE renter_profiles'),
      ['me', 'My story'],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO renter_preferences'),
      ['me', 1500],
    );
  });
  it.each([{}, { displayName: '   ' }, { registrationNumbers: ['  '] }])(
    'rejects empty profile changes %j',
    async (body) => {
      const { service } = setup('landlord');
      await expect(service.update(body)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );
});
