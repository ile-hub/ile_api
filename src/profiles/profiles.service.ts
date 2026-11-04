import { DemoPreviewService } from '../common/demo-preview.service';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RequestContextService } from '../common/request-context.service';
import { DiscoveryQuery, discoveryReasons } from './discovery';
import { UpdateProfileDto } from './profile.dto';
import type { OwnProfile, PublicProfile } from './profile.types';

const COMMON = {
  displayName: 'display_name',
  bio: 'bio',
  photoUrl: 'photo_url',
  discoverable: 'discoverable',
};
const RENTER = {
  currentLocation: 'current_location',
  targetMoveDate: 'target_move_date',
  householdSize: 'household_size',
  householdPreferences: 'household_preferences',
  personalStory: 'personal_story',
};
const PREFERENCES = {
  preferredLocation: 'preferred_location',
  budgetMin: 'budget_min',
  budgetMax: 'budget_max',
  tenancyLengthMonths: 'tenancy_length_months',
  householdType: 'household_type',
};
const LANDLORD = {
  companyName: 'company_name',
  landlordType: 'landlord_type',
  lettingExperienceYears: 'letting_experience_years',
  numberOfProperties: 'number_of_properties',
  locationsCovered: 'locations_covered',
  communicationStyle: 'communication_style',
  lettingApproach: 'letting_approach',
  tenantExpectations: 'tenant_expectations',
  tenancySuccess: 'tenancy_success',
  registrationNumbers: 'registration_numbers',
  registrationDetails: 'registration_details',
};

@Injectable()
export class ProfilesService {
  constructor(
    private readonly context: RequestContextService,
    private readonly demo: DemoPreviewService,
  ) {}

  private async role(): Promise<'renter' | 'landlord'> {
    const role = await this.context.getRole();
    if (role !== 'renter' && role !== 'landlord')
      throw new ForbiddenException('A renter or landlord profile is required');
    return role;
  }

  async discover(query: DiscoveryQuery) {
    await this.role();
    const own = await this.preview();
    const rows = await this.context
      .getClient()
      .query<{ profile: PublicProfile }>(
        'SELECT leri_discovery($1,$2) AS profile',
        [query.after ?? null, query.limit + 1],
      );
    const page: { profile: PublicProfile }[] = [];
    for (const { profile } of rows.rows.slice(0, query.limit))
      page.push({ profile: await this.demo.decorate(profile) });
    const items = page
      .map(({ profile }) => ({
        profile,
        reasons:
          query.mode === 'suggested' ? discoveryReasons(own, profile) : [],
      }))
      .filter((item) => query.mode !== 'suggested' || item.reasons.length > 0);
    return {
      items,
      nextCursor:
        rows.rows.length > query.limit ? page.at(-1)!.profile.id : null,
    };
  }

  async getOwn() {
    await this.role();
    const result = await this.context
      .getClient()
      .query<{ profile: OwnProfile | null }>(
        'SELECT leri_own_profile() AS profile',
      );
    if (!result.rows[0]?.profile)
      throw new NotFoundException('No profile exists for this account');
    return this.demo.decorate(result.rows[0].profile);
  }

  async getPublic(id: string) {
    await this.role();
    const result = await this.context
      .getClient()
      .query<{ profile: PublicProfile | null }>(
        'SELECT leri_public_profile($1) AS profile',
        [id],
      );
    if (!result.rows[0]?.profile) throw new NotFoundException();
    return this.demo.decorate(result.rows[0].profile);
  }

  async preview() {
    await this.role();
    const result = await this.context
      .getClient()
      .query<{ profile: PublicProfile | null }>(
        'SELECT leri_public_profile($1) AS profile',
        [this.context.getUserId()],
      );
    if (!result.rows[0]?.profile) throw new NotFoundException();
    return this.demo.decorate(result.rows[0].profile);
  }

  async update(body: UpdateProfileDto) {
    const role = await this.role();
    const allowed: Record<string, string> = {
      ...COMMON,
      ...(role === 'renter' ? { ...RENTER, ...PREFERENCES } : LANDLORD),
    };
    const entries = (Object.entries(body) as [string, unknown][]).filter(
      ([, value]) => value !== undefined,
    );
    if (!entries.length)
      throw new BadRequestException('No profile fields supplied');
    if (entries.some(([key]) => !Object.hasOwn(allowed, key)))
      throw new BadRequestException('Field is not editable for this role');
    if (typeof body.displayName === 'string' && !body.displayName.trim())
      throw new BadRequestException('displayName must not be blank');
    if (
      [body.registrationNumbers, body.locationsCovered].some((values) =>
        values?.some((v) => !v.trim()),
      )
    )
      throw new BadRequestException('Array entries must not be blank');

    const client = this.context.getClient();
    const id = this.context.getUserId();
    const table = role === 'renter' ? 'renter_profiles' : 'landlord_profiles';
    // Serialize updates across profile and preference rows, including partial budget edits.
    const locked = await client.query(
      `SELECT user_id FROM ${table} WHERE user_id = $1 FOR UPDATE`,
      [id],
    );
    if (!locked.rowCount)
      throw new NotFoundException('No profile exists for this account');
    if (role === 'renter') {
      const prefs = await client.query<{
        budget_min: string | null;
        budget_max: string | null;
      }>(
        'SELECT budget_min, budget_max FROM renter_preferences WHERE renter_id = $1',
        [id],
      );
      const minimum =
        body.budgetMin !== undefined
          ? body.budgetMin
          : prefs.rows[0]?.budget_min;
      const maximum =
        body.budgetMax !== undefined
          ? body.budgetMax
          : prefs.rows[0]?.budget_max;
      if (
        minimum != null &&
        maximum != null &&
        Number(minimum) > Number(maximum)
      )
        throw new BadRequestException('budgetMin must not exceed budgetMax');
      const preferenceEntries = entries.filter(([key]) =>
        Object.hasOwn(PREFERENCES, key),
      );
      if (preferenceEntries.length) {
        const columns = preferenceEntries.map(([key]) => allowed[key]);
        await client.query(
          `INSERT INTO renter_preferences (renter_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})
           ON CONFLICT (renter_id) DO UPDATE SET ${columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()`,
          [id, ...preferenceEntries.map(([, value]) => value)],
        );
      }
    }
    const profileEntries = entries.filter(
      ([key]) => role !== 'renter' || !Object.hasOwn(PREFERENCES, key),
    );
    if (profileEntries.length) {
      await client.query(
        `UPDATE ${table} SET ${profileEntries.map(([key], i) => `${allowed[key]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE user_id = $1`,
        [id, ...profileEntries.map(([, value]) => value)],
      );
    }
    return this.getOwn();
  }
}
