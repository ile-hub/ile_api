import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  LandlordProfileSummary,
  MeResponse,
  RenterProfileSummary,
  UserRole,
} from '@yourorg/ile-shared-types';
import { RequestContextService } from '../common/request-context.service';

interface MeRow {
  id: string;
  email: string;
  role: UserRole;
  renter_display_name: string | null;
  renter_bio: string | null;
  renter_institution_id: string | null;
  renter_created_at: Date | null;
  landlord_display_name: string | null;
  landlord_company_name: string | null;
  landlord_verification_status: string | null;
  landlord_created_at: Date | null;
}

@Injectable()
export class MeService {
  constructor(private readonly requestContext: RequestContextService) {}

  // Both profile joins are LEFT JOINs: exactly one matches for a renter or
  // landlord (handle_new_user creates it atomically at signup), neither
  // for an admin role. Both profile tables are RLS-scoped to the caller's
  // own row (renter_sees_own_profile / landlord_sees_own_profile), which
  // is what makes them visible here.
  async getMe(): Promise<MeResponse> {
    const client = this.requestContext.getClient();
    const userId = this.requestContext.getUserId();
    const result = await client.query<MeRow>(
      `SELECT u.id, u.email, u.role,
              rp.display_name        AS renter_display_name,
              rp.bio                 AS renter_bio,
              rp.institution_id      AS renter_institution_id,
              rp.created_at          AS renter_created_at,
              lp.display_name        AS landlord_display_name,
              lp.company_name        AS landlord_company_name,
              lp.verification_status AS landlord_verification_status,
              lp.created_at          AS landlord_created_at
       FROM users u
       LEFT JOIN renter_profiles rp ON rp.user_id = u.id
       LEFT JOIN landlord_profiles lp ON lp.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) {
      // Valid Supabase session, but no public.users row -- only possible
      // for an auth user created before the signup trigger existed.
      throw new NotFoundException('No profile exists for this account');
    }

    let profile: RenterProfileSummary | LandlordProfileSummary | null = null;
    let displayName: string | null = null;
    if (row.renter_created_at) {
      displayName = row.renter_display_name;
      profile = {
        kind: 'renter',
        bio: row.renter_bio,
        institutionId: row.renter_institution_id,
        createdAt: row.renter_created_at.toISOString(),
      };
    } else if (row.landlord_created_at) {
      displayName = row.landlord_display_name;
      profile = {
        kind: 'landlord',
        companyName: row.landlord_company_name,
        verificationStatus: row.landlord_verification_status ?? 'unverified',
        createdAt: row.landlord_created_at.toISOString(),
      };
    }

    return {
      id: row.id,
      email: row.email,
      role: row.role,
      displayName,
      profile,
    };
  }
}
