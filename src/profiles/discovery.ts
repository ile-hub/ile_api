import { Type } from 'class-transformer';
import { IsIn, IsInt, IsUUID, Max, Min, ValidateIf } from 'class-validator';
import type {
  PublicLandlordProfile,
  PublicProfile,
  PublicRenterProfile,
} from './profile.types';

export class DiscoveryQuery {
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsIn(['all', 'suggested'])
  mode: 'all' | 'suggested' = 'all';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsUUID()
  after?: string;
}

// Practical fit only. No evidence, verification, confidence or numerical ranking.
export function compatibilityReasons(
  renter: PublicRenterProfile,
  landlord: PublicLandlordProfile,
): string[] {
  const normalized = (value: string) => value.trim().toLocaleLowerCase('en-GB');
  for (const property of landlord.properties) {
    const reasons: string[] = [];
    if (renter.preferredLocation) {
      const area = normalized(renter.preferredLocation);
      if (
        ![
          property.city,
          property.details.publicArea,
          property.details.postcodeDistrict,
        ].some((value) => value && normalized(value) === area)
      )
        continue;
      reasons.push('In your preferred area');
    }
    if (renter.budgetMin !== null || renter.budgetMax !== null) {
      if (
        property.currency !== 'GBP' ||
        (renter.budgetMin !== null && property.rentAmount < renter.budgetMin) ||
        (renter.budgetMax !== null && property.rentAmount > renter.budgetMax)
      )
        continue;
      reasons.push('Rent fits the stated budget');
    }
    if (renter.targetMoveDate && property.details.availableFrom) {
      if (property.details.availableFrom > renter.targetMoveDate) continue;
      reasons.push('Available by the preferred move date');
    }
    if (renter.tenancyLengthMonths && property.details.minTenancyMonths) {
      if (renter.tenancyLengthMonths < property.details.minTenancyMonths)
        continue;
      reasons.push('Tenancy length fits the minimum term');
    }
    if (renter.householdSize && property.details.permittedOccupants) {
      if (renter.householdSize > property.details.permittedOccupants) continue;
      reasons.push('Space for the stated household size');
    }
    if (
      renter.householdPreferences.includes('pet_friendly') &&
      (property.propertyRules.includes('no_pets') ||
        property.details.petsPolicy === 'not_allowed')
    )
      continue;
    if (
      renter.householdPreferences.includes('smoke_free') &&
      property.details.smokingPolicy === 'allowed'
    )
      continue;
    if (reasons.length) return reasons;
  }
  return [];
}
export function discoveryReasons(
  own: PublicProfile,
  other: PublicProfile,
): string[] {
  return own.kind === 'renter' && other.kind === 'landlord'
    ? compatibilityReasons(own, other)
    : own.kind === 'landlord' && other.kind === 'renter'
      ? compatibilityReasons(other, own).map((reason) =>
          reason === 'In your preferred area'
            ? 'In the renter’s preferred area'
            : reason,
        )
      : [];
}
