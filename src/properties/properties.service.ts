import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  Property,
  PropertyFeedResponse,
  PropertyRule,
  PropertyStatus,
} from '@yourorg/ile-shared-types';
import { RequestContextService } from '../common/request-context.service';
import { CreatePropertyDto, UpdatePropertyDto } from './dto/property.dto';

interface PropertyRow {
  id: string;
  landlord_id: string;
  title: string | null;
  description: string | null;
  address_line1: string;
  city: string;
  postcode: string;
  bedrooms: number;
  rent_amount: string; // numeric comes back from pg as a string
  currency: string;
  property_rules: PropertyRule[];
  status: PropertyStatus;
  published_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, landlord_id, title, description, address_line1, city,
  postcode, bedrooms, rent_amount, currency, property_rules, status,
  published_at, archived_at, created_at, updated_at`;

// Request field -> column. Also the whitelist for PATCH: only keys listed
// here can ever reach the SET clause, and status is deliberately absent.
const UPDATABLE: Record<keyof UpdatePropertyDto, string> = {
  title: 'title',
  description: 'description',
  addressLine1: 'address_line1',
  city: 'city',
  postcode: 'postcode',
  bedrooms: 'bedrooms',
  rentAmount: 'rent_amount',
  propertyRules: 'property_rules',
};

function toProperty(row: PropertyRow): Property {
  return {
    id: row.id,
    landlordId: row.landlord_id,
    title: row.title,
    description: row.description,
    addressLine1: row.address_line1,
    city: row.city,
    postcode: row.postcode,
    bedrooms: row.bedrooms,
    rentAmount: Number(row.rent_amount),
    currency: row.currency,
    propertyRules: row.property_rules,
    status: row.status,
    publishedAt: row.published_at?.toISOString() ?? null,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// None of the reads here filter by landlord_id or status for visibility
// -- RLS does that (landlord: own rows; renter: published rows only). The
// explicit landlord_id/status predicates that DO appear are about which
// list the caller asked for, not about what they're allowed to see.
@Injectable()
export class PropertiesService {
  constructor(
    private readonly requestContext: RequestContextService,
    private readonly config: ConfigService,
  ) {}

  private async requireRole(role: 'renter' | 'landlord'): Promise<void> {
    if ((await this.requestContext.getRole()) !== role) {
      throw new ForbiddenException(`Only a ${role} can do this`);
    }
  }

  async create(body: CreatePropertyDto): Promise<Property> {
    // Without this a renter's insert still fails (no landlord_profiles
    // row for the FK), but as a 500 rather than a 403.
    await this.requireRole('landlord');
    const client = this.requestContext.getClient();
    const result = await client.query<PropertyRow>(
      `INSERT INTO properties
         (landlord_id, title, description, address_line1, city, postcode,
          bedrooms, rent_amount, property_rules)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${COLUMNS}`,
      [
        this.requestContext.getUserId(),
        body.title ?? null,
        body.description ?? null,
        body.addressLine1,
        body.city,
        body.postcode,
        body.bedrooms,
        body.rentAmount,
        body.propertyRules ?? [],
      ],
    );
    return toProperty(result.rows[0]);
  }

  async listMine(): Promise<Property[]> {
    await this.requireRole('landlord');
    const client = this.requestContext.getClient();
    const result = await client.query<PropertyRow>(
      `SELECT ${COLUMNS} FROM properties
       WHERE landlord_id = $1
       ORDER BY created_at DESC`,
      [this.requestContext.getUserId()],
    );
    return result.rows.map(toProperty);
  }

  // Renter feed. Fetches one extra row to answer hasMore without a
  // separate COUNT(*). The explicit status filter is redundant with the
  // renter RLS policy today; it stays so the feed can never start showing
  // drafts if a broader SELECT policy is added later.
  async feed(limit: number, offset: number): Promise<PropertyFeedResponse> {
    await this.requireRole('renter');
    const client = this.requestContext.getClient();
    const result = await client.query<PropertyRow>(
      `SELECT ${COLUMNS} FROM properties
       WHERE status = 'published'
       ORDER BY published_at DESC, id
       LIMIT $1 OFFSET $2`,
      [limit + 1, offset],
    );
    return {
      items: result.rows.slice(0, limit).map(toProperty),
      limit,
      offset,
      hasMore: result.rows.length > limit,
    };
  }

  // 404 for "doesn't exist", "not yours" and "not published" alike --
  // RLS makes all three the same zero-row result.
  async getById(id: string): Promise<Property> {
    const client = this.requestContext.getClient();
    const result = await client.query<PropertyRow>(
      `SELECT ${COLUMNS} FROM properties WHERE id = $1`,
      [id],
    );
    if (result.rowCount === 0) {
      throw new NotFoundException();
    }
    return toProperty(result.rows[0]);
  }

  async update(id: string, body: UpdatePropertyDto): Promise<Property> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [field, column] of Object.entries(UPDATABLE)) {
      const value = body[field as keyof UpdatePropertyDto];
      if (value !== undefined) {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length === 0) {
      throw new BadRequestException('No updatable fields supplied');
    }

    const client = this.requestContext.getClient();
    // landlord_id = session duplicates the RLS UPDATE policy on purpose
    // (defense in depth, same as tenancy_interests.decline). Archived
    // listings are read-only.
    const result = await client.query<PropertyRow>(
      `UPDATE properties SET ${sets.join(', ')}
       WHERE id = $1
         AND landlord_id = $${values.length + 1}
         AND status <> 'archived'
       RETURNING ${COLUMNS}`,
      [...values, this.requestContext.getUserId()],
    );
    if (result.rowCount === 0) {
      await this.throwOwnedButWrongState(
        id,
        'Archived properties cannot be edited',
      );
    }
    return toProperty(result.rows[0]);
  }

  async publish(id: string): Promise<Property> {
    if (this.config.get<string>('REQUIRE_VERIFICATION') === 'true') {
      await this.requireVerifiedLandlord();
    }
    return this.transition(id, 'published', ['draft']);
  }

  async archive(id: string): Promise<Property> {
    return this.transition(id, 'archived', ['draft', 'published']);
  }

  // Only reached when REQUIRE_VERIFICATION=true. Landlord verification
  // itself isn't built yet (endpoint.md: Landlord Verification), so
  // nothing currently sets verification_status to 'verified' -- with the
  // flag on, publishing is blocked for everyone until that exists.
  private async requireVerifiedLandlord(): Promise<void> {
    const client = this.requestContext.getClient();
    const result = await client.query<{ verification_status: string }>(
      'SELECT verification_status FROM landlord_profiles WHERE user_id = $1',
      [this.requestContext.getUserId()],
    );
    if (result.rows[0]?.verification_status !== 'verified') {
      throw new ForbiddenException(
        'Landlord verification is required before publishing',
      );
    }
  }

  // The legal from-states are checked here for a clear 409; the
  // properties_status_transition trigger enforces the same rules (and
  // stamps published_at/archived_at) for any connection.
  private async transition(
    id: string,
    to: PropertyStatus,
    from: PropertyStatus[],
  ): Promise<Property> {
    const client = this.requestContext.getClient();
    const result = await client.query<PropertyRow>(
      `UPDATE properties SET status = $2
       WHERE id = $1 AND landlord_id = $3 AND status = ANY($4::property_status[])
       RETURNING ${COLUMNS}`,
      [id, to, this.requestContext.getUserId(), from],
    );
    if (result.rowCount === 0) {
      await this.throwOwnedButWrongState(
        id,
        `Only a ${from.join(' or ')} property can be ${to}`,
      );
    }
    return toProperty(result.rows[0]);
  }

  // After a zero-row UPDATE: 409 if the caller owns the property (so it
  // was the status guard that failed -- telling the owner that leaks
  // nothing), otherwise a plain 404.
  private async throwOwnedButWrongState(
    id: string,
    message: string,
  ): Promise<never> {
    const client = this.requestContext.getClient();
    const owned = await client.query(
      'SELECT 1 FROM properties WHERE id = $1 AND landlord_id = $2',
      [id, this.requestContext.getUserId()],
    );
    if (owned.rowCount === 0) {
      throw new NotFoundException();
    }
    throw new ConflictException(message);
  }
}
