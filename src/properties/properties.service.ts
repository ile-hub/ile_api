import { DemoPreviewService } from '../common/demo-preview.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PropertyDetailsDto, UpdatePhotoDto } from './dto/property-details.dto';
import {
  PropertyArcsDto,
  type ArcsPreferences,
} from '../landlords/arcs-preferences.dto';
import { LandlordsService } from '../landlords/landlords.service';
import {
  PrivateStorageService,
  PHOTO_BUCKET,
  preparePropertyPhoto,
  safeFileName,
  type UploadedAsset,
} from '../common/private-storage.service';
import { ConfigService } from '@nestjs/config';
import type {
  Property,
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
  details: PropertyDetailsDto;
  availability_status: string;
  arcs_preference_mode: string;
}

const COLUMNS = `id, landlord_id, title, description, address_line1, city,
  postcode, bedrooms, rent_amount, currency, property_rules, status,
  published_at, archived_at, created_at, updated_at, details, availability_status, arcs_preference_mode`;

// Request field -> column. Also the whitelist for PATCH: only keys listed
// here can ever reach the SET clause, and status is deliberately absent.
const UPDATABLE: Record<Exclude<keyof UpdatePropertyDto, 'details'>, string> = {
  title: 'title',
  description: 'description',
  addressLine1: 'address_line1',
  city: 'city',
  postcode: 'postcode',
  bedrooms: 'bedrooms',
  rentAmount: 'rent_amount',
  propertyRules: 'property_rules',
};

export type OwnerProperty = Property & {
  details?: PropertyDetailsDto;
  listingStatus?: string;
};
export type PublicProperty = Omit<Property, 'addressLine1' | 'postcode'> & {
  details: Omit<
    PropertyDetailsDto,
    | 'privateReference'
    | 'registrationNumbers'
    | 'registrationDetails'
    | 'hmoLicenceDetails'
  >;
  listingStatus: string;
  presentation?: {
    mode: 'synthetic_demo_preview';
    label: string;
    photosIllustrative: true;
  };
  arcsPreferences: import('../landlords/arcs-preferences.dto').ArcsPreferences;
  photos: {
    id: string;
    caption: string | null;
    position: number;
    mimeType: string;
  }[];
};
interface PhotoRow {
  id: string;
  property_id: string;
  object_path: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  caption: string | null;
  position: number;
  created_at: Date;
}
function photoResponse(row: PhotoRow) {
  return {
    id: row.id,
    propertyId: row.property_id,
    fileName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    caption: row.caption,
    position: row.position,
    createdAt: row.created_at.toISOString(),
  };
}
export function checkPropertyDetails(details: PropertyDetailsDto) {
  if (
    validateSync(plainToInstance(PropertyDetailsDto, details), {
      whitelist: true,
      forbidNonWhitelisted: true,
    }).length
  )
    throw new BadRequestException('Invalid property details');
  if (details.billsIncluded?.some((b) => details.billsExcluded?.includes(b)))
    throw new BadRequestException(
      'A bill cannot be both included and excluded',
    );
  if (
    details.minTenancyMonths != null &&
    details.expectedTenancyMonths != null &&
    details.minTenancyMonths > details.expectedTenancyMonths
  )
    throw new BadRequestException('Minimum tenancy exceeds expected duration');
  if (
    details.hmoLicenceStatus === 'licensed' &&
    !details.hmoLicenceDetails?.trim()
  )
    throw new BadRequestException(
      'HMO licence details are required for licensed properties',
    );
  if (Boolean(details.walkthroughUrl) !== Boolean(details.walkthroughType))
    throw new BadRequestException(
      'Walkthrough URL and type must be supplied together',
    );
  if (details.registrationNumbers?.some((n) => !n.trim()))
    throw new BadRequestException('Registration numbers cannot be blank');
}
export function mergePropertyDetails(
  prior: PropertyDetailsDto,
  patch: PropertyDetailsDto,
): PropertyDetailsDto {
  const supplied = Object.fromEntries(
    (Object.entries(patch) as [string, unknown][]).filter(
      ([, value]) => value !== undefined,
    ),
  );
  const merged = { ...prior, ...supplied };
  checkPropertyDetails(merged);
  return merged;
}
function toProperty(row: PropertyRow): OwnerProperty {
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
    ...(Object.keys(row.details).length ||
    row.availability_status !== 'available'
      ? {
          details: row.details,
          listingStatus:
            row.status === 'draft'
              ? 'draft'
              : row.status === 'archived' ||
                  row.availability_status === 'unavailable'
                ? 'unavailable'
                : 'available',
        }
      : {}),
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
    private readonly storage: PrivateStorageService,
    private readonly landlords: LandlordsService,
    private readonly demo: DemoPreviewService,
  ) {}

  private async requireRole(role: 'renter' | 'landlord'): Promise<void> {
    if ((await this.requestContext.getRole()) !== role) {
      throw new ForbiddenException(`Only a ${role} can do this`);
    }
  }

  async create(body: CreatePropertyDto): Promise<OwnerProperty> {
    // Without this a renter's insert still fails (no landlord_profiles
    // row for the FK), but as a 500 rather than a 403.
    await this.requireRole('landlord');
    const client = this.requestContext.getClient();
    if (body.details) checkPropertyDetails(body.details);
    const result = await client.query<PropertyRow>(
      `INSERT INTO properties
         (landlord_id, title, description, address_line1, city, postcode,
          bedrooms, rent_amount, property_rules, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,$10)
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
        JSON.stringify(body.details ?? {}),
      ],
    );
    return toProperty(result.rows[0]);
  }

  async listMine(): Promise<OwnerProperty[]> {
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
  async feed(limit: number, offset: number) {
    await this.requireRole('renter');
    const result = await this.requestContext
      .getClient()
      .query<{ item: PublicProperty }>(
        'SELECT item FROM leri_public_properties(NULL,$1,$2) item',
        [limit + 1, offset],
      );
    return {
      items: result.rows.slice(0, limit).map((r) => r.item),
      limit,
      offset,
      hasMore: result.rows.length > limit,
    };
  }
  private async publicProperty(id: string, landlordId?: string) {
    const result = await this.requestContext
      .getClient()
      .query<{ item: PublicProperty | null }>(
        'SELECT leri_public_property($1) AS item',
        [id],
      );
    const item =
      result.rows[0]?.item ??
      (await this.demo.properties(landlordId)).find((p) => p.id === id);
    if (!item || (landlordId && item.landlordId !== landlordId))
      throw new NotFoundException();
    return item;
  }
  async getById(id: string): Promise<OwnerProperty | PublicProperty> {
    if ((await this.requestContext.getRole()) === 'renter')
      return this.publicProperty(id);
    await this.requireRole('landlord');
    const result = await this.requestContext
      .getClient()
      .query<PropertyRow>(
        `SELECT ${COLUMNS} FROM properties WHERE id=$1 AND landlord_id=$2`,
        [id, this.requestContext.getUserId()],
      );
    if (!result.rows[0]) throw new NotFoundException();
    return toProperty(result.rows[0]);
  }
  async publicList(landlordId: string) {
    const role = await this.requestContext.getRole();
    if (
      role !== 'renter' &&
      !(role === 'landlord' && landlordId === this.requestContext.getUserId())
    )
      throw new ForbiddenException();
    const result = await this.requestContext
      .getClient()
      .query<{ item: PublicProperty }>(
        'SELECT item FROM leri_public_properties($1,100,0) item',
        [landlordId],
      );
    return [
      ...result.rows.map((r) => r.item),
      ...(await this.demo.properties(landlordId)),
    ];
  }
  async publicDetail(landlordId: string, id: string) {
    return this.publicProperty(id, landlordId);
  }
  private async owned(id: string, editable = true) {
    if ((await this.requestContext.getRole()) !== 'landlord')
      throw new NotFoundException();
    const result = await this.requestContext
      .getClient()
      .query<PropertyRow>(
        `SELECT ${COLUMNS} FROM properties WHERE id=$1 AND landlord_id=$2 FOR UPDATE`,
        [id, this.requestContext.getUserId()],
      );
    if (!result.rows[0]) throw new NotFoundException();
    if (editable && result.rows[0].status === 'archived')
      throw new ConflictException('Archived properties are read-only');
    return result.rows[0];
  }

  async update(id: string, body: UpdatePropertyDto): Promise<OwnerProperty> {
    const prior = await this.owned(id);
    if (body.details) mergePropertyDetails(prior.details, body.details);
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [field, column] of Object.entries(UPDATABLE)) {
      const value = body[field as keyof UpdatePropertyDto];
      if (value !== undefined) {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (body.details !== undefined) {
      values.push(JSON.stringify(body.details));
      sets.push(`details = details || $${values.length}::jsonb`);
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

  async publish(id: string): Promise<OwnerProperty> {
    const property = await this.owned(id);
    await this.requireComplete(property);
    if (this.config.get<string>('REQUIRE_VERIFICATION') === 'true') {
      await this.requireVerifiedLandlord();
    }
    return this.transition(id, 'published', ['draft']);
  }

  async archive(id: string): Promise<OwnerProperty> {
    return this.transition(id, 'archived', ['draft', 'published']);
  }

  // Only reached when REQUIRE_VERIFICATION=true. Landlord verification
  // itself isn't built yet (endpoint.md: Landlord Verification), so
  // nothing currently sets verification_status to 'verified' -- with the
  // flag on, publishing is blocked for everyone until that exists.
  private async requireVerifiedLandlord(): Promise<void> {
    const client = this.requestContext.getClient();
    const result = await client.query<{
      identity_status: string;
      registration_verification_status: string;
      is_demo: boolean;
    }>(
      'SELECT identity_status,registration_verification_status,is_demo FROM landlord_profiles WHERE user_id=$1',
      [this.requestContext.getUserId()],
    );
    if (
      result.rows[0]?.identity_status !== 'verified' ||
      result.rows[0]?.registration_verification_status !== 'verified' ||
      result.rows[0]?.is_demo
    ) {
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
  ): Promise<OwnerProperty> {
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
  private async requireComplete(row: PropertyRow) {
    if (!Object.keys(row.details).length) return; // Historical/minimal CRUD stays compatible.
    const required: (keyof PropertyDetailsDto)[] = [
      'publicArea',
      'postcodeDistrict',
      'depositAmount',
      'availableFrom',
      'minTenancyMonths',
      'propertyType',
      'bathrooms',
      'permittedOccupants',
      'furnishing',
      'councilTaxBand',
      'epcRating',
      'hmoLicenceStatus',
    ];
    if (
      required.some((k) => row.details[k] == null || row.details[k] === '') ||
      !row.details.registrationNumbers?.length
    )
      throw new BadRequestException(
        'Complete rental details and registration information are required before availability',
      );
    const photos = await this.requestContext
      .getClient()
      .query<{ n: number }>(
        'SELECT count(*)::int AS n FROM leri_property_photos WHERE property_id=$1 AND removed_at IS NULL',
        [row.id],
      );
    if (!photos.rows[0].n)
      throw new BadRequestException('At least one property photo is required');
  }
  async availability(id: string, status: 'available' | 'unavailable') {
    const row = await this.owned(id);
    if (row.status !== 'published')
      throw new ConflictException(
        'Only published listings can change availability',
      );
    if (status === 'available') {
      await this.requireComplete(row);
      if (this.config.get<string>('REQUIRE_VERIFICATION') === 'true')
        await this.requireVerifiedLandlord();
    }
    const result = await this.requestContext
      .getClient()
      .query<PropertyRow>(
        `UPDATE properties SET availability_status=$2 WHERE id=$1 RETURNING ${COLUMNS}`,
        [id, status],
      );
    return { ...toProperty(result.rows[0]), listingStatus: status };
  }
  async arcs(id: string) {
    const row = await this.owned(id, false);
    const client = this.requestContext.getClient();
    const stored = await client.query<ArcsPreferences>(
      'SELECT priority_order AS "priorityOrder",evidence_preferences AS "evidencePreferences" FROM landlord_preferences WHERE landlord_id=$1 AND property_id=$2 AND is_mvp_settings',
      [this.requestContext.getUserId(), id],
    );
    return {
      mode: row.arcs_preference_mode,
      effective: await this.landlords.getArcs(id),
      override: stored.rows[0] ?? null,
    };
  }
  async saveArcs(id: string, body: PropertyArcsDto) {
    await this.owned(id);
    if (
      body.mode === 'default' &&
      (body.priorityOrder !== undefined ||
        body.evidencePreferences !== undefined)
    )
      throw new BadRequestException(
        'Default mode inherits landlord preferences',
      );
    await this.requestContext
      .getClient()
      .query('UPDATE properties SET arcs_preference_mode=$2 WHERE id=$1', [
        id,
        body.mode,
      ]);
    if (body.mode === 'custom')
      await this.landlords.saveArcs(
        {
          priorityOrder: body.priorityOrder!,
          evidencePreferences: body.evidencePreferences!,
        },
        id,
      );
    return this.arcs(id);
  }
  async photos(id: string) {
    await this.owned(id, false);
    const result = await this.requestContext
      .getClient()
      .query<PhotoRow>(
        'SELECT * FROM leri_property_photos WHERE property_id=$1 AND removed_at IS NULL ORDER BY position,id',
        [id],
      );
    return result.rows.map(photoResponse);
  }
  async uploadPhoto(id: string, input: UploadedAsset) {
    await this.owned(id);
    const file = await preparePropertyPhoto(input),
      client = this.requestContext.getClient();
    const count = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM leri_property_photos WHERE property_id=$1 AND removed_at IS NULL',
      [id],
    );
    if (count.rows[0].n >= 20)
      throw new BadRequestException('Maximum 20 photos per property');
    const photoId = randomUUID(),
      owner = this.requestContext.getUserId(),
      path = `${owner}/property/${id}/${photoId}`;
    await this.storage.upload(PHOTO_BUCKET, path, file);
    const result = await client.query<PhotoRow>(
      'INSERT INTO leri_property_photos(id,property_id,owner_id,object_path,original_name,mime_type,size_bytes,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [
        photoId,
        id,
        owner,
        path,
        safeFileName(file.originalname),
        file.mimetype,
        file.size,
        count.rows[0].n,
      ],
    );
    return photoResponse(result.rows[0]);
  }
  private async photo(id: string, photoId: string, editable = true) {
    await this.owned(id, editable);
    const result = await this.requestContext
      .getClient()
      .query<PhotoRow>(
        'SELECT * FROM leri_property_photos WHERE property_id=$1 AND id=$2 AND removed_at IS NULL FOR UPDATE',
        [id, photoId],
      );
    if (!result.rows[0]) throw new NotFoundException();
    return result.rows[0];
  }
  async updatePhoto(id: string, photoId: string, body: UpdatePhotoDto) {
    const prior = await this.photo(id, photoId);
    if (body.caption === undefined && body.position === undefined)
      throw new BadRequestException('No editable photo fields');
    const result = await this.requestContext
      .getClient()
      .query<PhotoRow>(
        'UPDATE leri_property_photos SET caption=$2,position=$3 WHERE id=$1 RETURNING *',
        [
          photoId,
          body.caption === undefined ? prior.caption : body.caption,
          body.position ?? prior.position,
        ],
      );
    return photoResponse(result.rows[0]);
  }
  async removePhoto(id: string, photoId: string) {
    const photo = await this.photo(id, photoId, false);
    await this.storage.remove(PHOTO_BUCKET, photo.object_path);
    await this.requestContext
      .getClient()
      .query('UPDATE leri_property_photos SET removed_at=now() WHERE id=$1', [
        photoId,
      ]);
    // Required modern gallery disappears when its final photo is removed.
    await this.requestContext
      .getClient()
      .query(
        `UPDATE properties SET availability_status='unavailable' WHERE id=$1 AND status='published' AND details<>'{}'::jsonb AND NOT EXISTS(SELECT 1 FROM leri_property_photos WHERE property_id=$1 AND removed_at IS NULL)`,
        [id],
      );
    return { removed: true };
  }
  async downloadPhoto(id: string, photoId: string, landlordId?: string) {
    if (landlordId || (await this.requestContext.getRole()) === 'renter') {
      const item = await this.publicProperty(id, landlordId);
      if (!item.photos.some((p) => p.id === photoId))
        throw new NotFoundException();
      if (item.presentation?.mode === 'synthetic_demo_preview') {
        const path = await this.demo.photoPath(id, photoId);
        if (!path) throw new NotFoundException();
        return this.storage.download(
          PHOTO_BUCKET,
          path,
          this.demo.storageToken(),
        );
      }
      const result = await this.requestContext
        .getClient()
        .query<{ path: string | null }>(
          'SELECT leri_public_photo_path($1,$2) AS path',
          [id, photoId],
        );
      if (!result.rows[0]?.path) throw new NotFoundException();
      return this.storage.download(PHOTO_BUCKET, result.rows[0].path);
    }
    const photo = await this.photo(id, photoId, false);
    return this.storage.download(PHOTO_BUCKET, photo.object_path);
  }
}
