import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  TenancyInterest,
  TenancyInterestStatus,
} from '@yourorg/ile-shared-types';
import { DatabaseError } from 'pg';
import { RequestContextService } from '../common/request-context.service';
import type { ListableStatus } from './dto/tenancy-interest.dto';

interface TenancyInterestRow {
  id: string;
  renter_id: string;
  property_id: string;
  status: TenancyInterestStatus;
  renter_interested_at: Date | null;
  landlord_interested_at: Date | null;
  matched_at: Date | null;
  created_at: Date;
  counterparty_display_name: string | null;
  address_line1: string | null;
  city: string | null;
  postcode: string | null;
  bedrooms: number | null;
  rent_amount: string | null;
  currency: string | null;
}

// Same generic message for every "this pairing can't take interest" case
// -- closed by the caller, closed by the other side, or otherwise
// blocked -- so the response doesn't reveal which side declined.
const PAIRING_CLOSED = 'Interest can no longer be expressed for this pairing';

// The enriched read used by every endpoint here. Exposes ONLY the other
// party's display name and a property summary -- no evidence, pillar or
// trust data is joined at all.
//
// Visibility is entirely RLS's job:
//   - tenancy_interests' SELECT policy limits rows to the caller's own
//     pairings, and hides a declined row from the side that didn't
//     decline it.
//   - properties is a LEFT JOIN because a renter can only see published
//     properties; an interest in a since-archived listing still comes
//     back, with property: null.
//   - The counterparty name is the landlord's (landlord_profiles has no
//     RLS) when the caller is the renter, and comes from
//     tenancy_interest_renter_display_name() when the caller is the
//     landlord -- renter_profiles' own RLS doesn't let the landlord read
//     it, and that function returns that one column and nothing else.
//
// $1 is always the caller's id.
const ENRICHED_SELECT = `
  SELECT ti.id, ti.renter_id, ti.property_id, ti.status,
         ti.renter_interested_at, ti.landlord_interested_at,
         ti.matched_at, ti.created_at,
         CASE WHEN ti.renter_id = $1 THEN lp.display_name
              ELSE tenancy_interest_renter_display_name(ti.id)
         END AS counterparty_display_name,
         p.address_line1, p.city, p.postcode, p.bedrooms,
         p.rent_amount, p.currency
  FROM tenancy_interests ti
  LEFT JOIN properties p ON p.id = ti.property_id
  LEFT JOIN landlord_profiles lp ON lp.user_id = p.landlord_id`;

function toTenancyInterest(row: TenancyInterestRow): TenancyInterest {
  return {
    id: row.id,
    renterId: row.renter_id,
    propertyId: row.property_id,
    status: row.status,
    renterInterestedAt: row.renter_interested_at?.toISOString() ?? null,
    landlordInterestedAt: row.landlord_interested_at?.toISOString() ?? null,
    matchedAt: row.matched_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    counterparty: { displayName: row.counterparty_display_name },
    property:
      row.address_line1 === null
        ? null
        : {
            addressLine1: row.address_line1,
            city: row.city!,
            postcode: row.postcode!,
            bedrooms: row.bedrooms!,
            rentAmount: Number(row.rent_amount),
            currency: row.currency!,
          },
  };
}

@Injectable()
export class TenancyInterestsService {
  constructor(private readonly requestContext: RequestContextService) {}

  // Mutual matching (this table) is distinct from `matches` (the
  // system-computed compatibility score, untouched by this feature) --
  // see the tenancy_interests migration's header note.
  //
  // Branches on the caller's users.role, not on whether renterId was
  // sent: a renter's renterId is ignored (renter_id always comes from the
  // session), a landlord must name the renter.
  //
  // Who may set which column, and that the property must be published,
  // is also enforced by the tenancy_interests_enforce_write_rules
  // trigger; the checks here exist to return clear 4xx responses.
  async expressInterest(
    propertyId: string,
    renterIdFromBody?: string,
  ): Promise<TenancyInterest> {
    const client = this.requestContext.getClient();
    const callerId = this.requestContext.getUserId();
    const role = await this.requestContext.getRole();

    if (role === 'landlord') {
      if (!renterIdFromBody) {
        throw new BadRequestException(
          'renterId is required when a landlord expresses interest',
        );
      }
      // 404, not 403 -- doesn't confirm whether the property exists at
      // all vs. exists but isn't theirs.
      const owned = await client.query<{ status: string }>(
        'SELECT status FROM properties WHERE id = $1 AND landlord_id = $2',
        [propertyId, callerId],
      );
      if (owned.rowCount === 0) {
        throw new NotFoundException();
      }
      if (owned.rows[0].status !== 'published') {
        throw new ConflictException(
          'Interest can only be expressed on a published property',
        );
      }
      // Checked against `users`, not `renter_profiles` -- renter_profiles'
      // SELECT policy only lets a landlord see a renter who has an
      // `applications` row with them, which a landlord expressing interest
      // first won't have. `users` has no RLS, so this check is accurate.
      const renterExists = await client.query(
        "SELECT 1 FROM users WHERE id = $1 AND role = 'renter'",
        [renterIdFromBody],
      );
      if (renterExists.rowCount === 0) {
        // The landlord already proved ownership, so there's no privacy
        // reason to hide "that renterId doesn't exist" from them.
        throw new BadRequestException(
          'renterId does not correspond to an existing renter',
        );
      }
      return this.upsert(
        propertyId,
        renterIdFromBody,
        'landlord_interested_at',
      );
    }

    if (role !== 'renter') {
      throw new ForbiddenException(
        'Only renters and landlords can express interest',
      );
    }
    // RLS shows a renter published properties only, so a draft, archived
    // or nonexistent property are all the same 404 here.
    const visible = await client.query(
      'SELECT 1 FROM properties WHERE id = $1',
      [propertyId],
    );
    if (visible.rowCount === 0) {
      throw new NotFoundException();
    }
    return this.upsert(propertyId, callerId, 'renter_interested_at');
  }

  // `column` is never derived from request input -- it's one of exactly
  // two hardcoded literals chosen above, so interpolating it is not an
  // injection risk (renterId/propertyId are always bound parameters).
  //
  // ON CONFLICT ... DO UPDATE ... WHERE, not check-then-insert: atomic
  // against two concurrent requests for the same pair. COALESCE keeps
  // the first timestamp -- the write-rules trigger forbids rewriting it.
  //
  // Two ways the update path can be blocked, both mapped to the same 409:
  //   - the row is visible to the caller but declined (by them) -> the
  //     WHERE guard makes it a zero-row result;
  //   - the row was declined by the OTHER side -> RLS hides it from the
  //     caller, and Postgres raises insufficient_privilege (42501) rather
  //     than skipping it, because ON CONFLICT DO UPDATE won't silently
  //     ignore a conflicting row the caller can't update.
  private async upsert(
    propertyId: string,
    renterId: string,
    column: 'renter_interested_at' | 'landlord_interested_at',
  ): Promise<TenancyInterest> {
    const client = this.requestContext.getClient();
    let id: string | undefined;
    try {
      // SAVEPOINT so a 42501 from the RLS check doesn't abort the
      // request's whole transaction before the 409 is returned.
      await client.query('SAVEPOINT express_interest');
      const result = await client.query<{ id: string }>(
        `INSERT INTO tenancy_interests (renter_id, property_id, ${column})
         VALUES ($1, $2, now())
         ON CONFLICT (renter_id, property_id)
         DO UPDATE SET ${column} = COALESCE(tenancy_interests.${column}, now())
         WHERE tenancy_interests.status IN ('pending', 'matched')
         RETURNING id`,
        [renterId, propertyId],
      );
      await client.query('RELEASE SAVEPOINT express_interest');
      id = result.rows[0]?.id;
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT express_interest');
      if (err instanceof DatabaseError && err.code === '42501') {
        throw new ConflictException(PAIRING_CLOSED);
      }
      throw err;
    }
    if (!id) {
      throw new ConflictException(PAIRING_CLOSED);
    }
    return this.getById(id);
  }

  // Either party may decline -- declined_by is computed from WHICH
  // condition matched, not supplied by the caller. The ownership check
  // duplicates RLS on purpose (defense in depth): this query is correct
  // even if RLS were ever misconfigured.
  async decline(id: string): Promise<TenancyInterest> {
    const client = this.requestContext.getClient();
    const callerId = this.requestContext.getUserId();

    const result = await client.query<{ id: string }>(
      `UPDATE tenancy_interests
       SET status = 'declined',
           declined_by = CASE WHEN renter_id = $2 THEN 'renter' ELSE 'landlord' END
       WHERE id = $1
         AND status IN ('pending', 'matched')
         AND (
           renter_id = $2
           OR EXISTS (
             SELECT 1 FROM properties p
             WHERE p.id = tenancy_interests.property_id AND p.landlord_id = $2
           )
         )
       RETURNING id`,
      [id, callerId],
    );

    if (result.rowCount === 0) {
      // Ambiguous on purpose: doesn't exist, isn't yours, hidden from you,
      // or already declined -- a zero-row UPDATE collapses to a plain 404.
      throw new NotFoundException();
    }
    return this.getById(id);
  }

  async getById(id: string): Promise<TenancyInterest> {
    const client = this.requestContext.getClient();
    const result = await client.query<TenancyInterestRow>(
      `${ENRICHED_SELECT} WHERE ti.id = $2`,
      [this.requestContext.getUserId(), id],
    );
    if (result.rowCount === 0) {
      throw new NotFoundException();
    }
    return toTenancyInterest(result.rows[0]);
  }

  // Every row the caller is a party to: a renter's own interests, or
  // every interest across a landlord's properties. No status = everything
  // except declined; ?status=declined returns only rows the CALLER
  // declined (RLS hides the rest).
  async listMine(status?: ListableStatus): Promise<TenancyInterest[]> {
    const client = this.requestContext.getClient();
    const result = await client.query<TenancyInterestRow>(
      `${ENRICHED_SELECT}
       WHERE ${status ? 'ti.status = $2' : "ti.status <> 'declined'"}
       ORDER BY ti.created_at DESC`,
      status
        ? [this.requestContext.getUserId(), status]
        : [this.requestContext.getUserId()],
    );
    return result.rows.map(toTenancyInterest);
  }

  // The Applicants list: one property's rows, 'pending' unless another
  // status is asked for. A status filter on the same table, not a
  // separate queue.
  async listForProperty(
    propertyId: string,
    status: ListableStatus = 'pending',
  ): Promise<TenancyInterest[]> {
    const client = this.requestContext.getClient();
    const callerId = this.requestContext.getUserId();

    const owns = await client.query(
      'SELECT 1 FROM properties WHERE id = $1 AND landlord_id = $2',
      [propertyId, callerId],
    );
    if (owns.rowCount === 0) {
      throw new NotFoundException();
    }

    const result = await client.query<TenancyInterestRow>(
      `${ENRICHED_SELECT}
       WHERE ti.property_id = $2 AND ti.status = $3
       ORDER BY ti.created_at DESC`,
      [callerId, propertyId, status],
    );
    return result.rows.map(toTenancyInterest);
  }
}
