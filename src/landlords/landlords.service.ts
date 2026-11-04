import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
export interface SafeLandlordPublicProfile {
  id: string;
  displayName: string;
  memberSince: string;
  properties: {
    id: string;
    city: string;
    bedrooms: number;
    rentAmount: number;
  }[];
}
import {
  ArcsPreferencesDto,
  type ArcsPreferences,
} from './arcs-preferences.dto';
import { RequestContextService } from '../common/request-context.service';

interface ProfileRow {
  id: string;
  display_name: string;
  member_since: Date;
}

@Injectable()
export class LandlordsService {
  constructor(private readonly requestContext: RequestContextService) {}

  // Renter-only. Landlords get a plain 403 even for their own id -- they
  // have GET /me and GET /properties/me for that, and one rule is simpler
  // than "only yourself". landlord_public_profile() enforces renter-only
  // too, so this check is for a clear status code, not the security.
  async getPublicProfile(
    landlordId: string,
  ): Promise<SafeLandlordPublicProfile> {
    if ((await this.requestContext.getRole()) !== 'renter') {
      throw new ForbiddenException('Only renters can view landlord profiles');
    }

    const client = this.requestContext.getClient();
    const profile = await client.query<ProfileRow>(
      'SELECT id, display_name, member_since FROM landlord_public_profile($1)',
      [landlordId],
    );
    if (profile.rowCount === 0) {
      // Unknown id, not a landlord, or no published properties -- all the
      // same 404, so the endpoint never confirms a landlord exists.
      throw new NotFoundException();
    }

    // Read under the renter's own RLS (published rows only); the explicit
    // status filter keeps the list correct even if a broader SELECT policy
    // is added to properties later.
    const properties = await client.query<{
      item: { id: string; city: string; bedrooms: number; rentAmount: number };
    }>('SELECT item FROM leri_public_properties($1,100,0) item', [landlordId]);

    const row = profile.rows[0];
    return {
      id: row.id,
      displayName: row.display_name,
      memberSince: row.member_since.toISOString(),
      properties: properties.rows.map(({ item: p }) => ({
        id: p.id,
        city: p.city,
        bedrooms: p.bedrooms,
        rentAmount: p.rentAmount,
      })),
    };
  }
  async getArcs(propertyId?: string): Promise<ArcsPreferences> {
    if ((await this.requestContext.getRole()) !== 'landlord')
      throw new ForbiddenException(
        'Only landlords can manage ARCS preferences',
      );
    const result = await this.requestContext
      .getClient()
      .query<{ settings: ArcsPreferences }>(
        'SELECT leri_effective_arcs($1,$2) AS settings',
        [this.requestContext.getUserId(), propertyId ?? null],
      );
    return result.rows[0].settings;
  }
  async saveArcs(body: ArcsPreferencesDto, propertyId?: string) {
    if ((await this.requestContext.getRole()) !== 'landlord')
      throw new ForbiddenException(
        'Only landlords can manage ARCS preferences',
      );
    const entries = Object.entries(body.evidencePreferences);
    if (
      entries.some(([, v]) => !['accept', 'prefer', 'not_needed'].includes(v))
    )
      throw new BadRequestException('Unknown evidence preference choice');
    const client = this.requestContext.getClient(),
      owner = this.requestContext.getUserId();
    const options = await client.query<{ id: string }>(
      'SELECT id FROM leri_evidence_catalogue WHERE id=ANY($1::text[]) AND active',
      [entries.map(([k]) => k)],
    );
    if (options.rows.length !== entries.length)
      throw new BadRequestException('Unknown or inactive evidence option');
    // Lock the profile so two first saves cannot race on the partial unique index.
    await client.query(
      'SELECT user_id FROM landlord_profiles WHERE user_id=$1 FOR UPDATE',
      [owner],
    );
    const prior = await client.query<{ id: string }>(
      'SELECT id FROM landlord_preferences WHERE landlord_id=$1 AND property_id IS NOT DISTINCT FROM $2::uuid AND is_mvp_settings',
      [owner, propertyId ?? null],
    );
    if (prior.rows[0])
      await client.query(
        'UPDATE landlord_preferences SET priority_order=$2,evidence_preferences=$3,updated_at=now() WHERE id=$1',
        [
          prior.rows[0].id,
          body.priorityOrder,
          JSON.stringify(body.evidencePreferences),
        ],
      );
    else
      await client.query(
        'INSERT INTO landlord_preferences(landlord_id,property_id,is_mvp_settings,priority_order,evidence_preferences) VALUES($1,$2,true,$3,$4)',
        [
          owner,
          propertyId ?? null,
          body.priorityOrder,
          JSON.stringify(body.evidencePreferences),
        ],
      );
    return this.getArcs(propertyId);
  }
}
