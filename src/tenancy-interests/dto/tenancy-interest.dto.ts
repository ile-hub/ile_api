import type {
  ExpressInterestRequest,
  TenancyInterestStatus,
} from '@yourorg/ile-shared-types';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class ExpressInterestDto implements ExpressInterestRequest {
  @IsUUID()
  propertyId!: string;

  @IsOptional()
  @IsUUID()
  renterId?: string;
}

// 'withdrawn' is omitted: nothing can reach it yet, so filtering on it
// would only ever return an empty list.
export const LISTABLE_STATUSES = ['pending', 'matched', 'declined'] as const;
export type ListableStatus = (typeof LISTABLE_STATUSES)[number] &
  TenancyInterestStatus;

export class ListTenancyInterestsQueryDto {
  @IsOptional()
  @IsIn(LISTABLE_STATUSES)
  status?: ListableStatus;
}
