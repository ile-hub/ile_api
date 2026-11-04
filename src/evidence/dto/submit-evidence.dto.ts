import type { TrustPillar } from '@yourorg/ile-shared-types';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
export const TRUST_PILLARS: readonly TrustPillar[] = [
  'community',
  'affordability',
  'reliability',
  'stability',
];
export class SubmitEvidenceDto {
  @IsIn(TRUST_PILLARS) pillar!: TrustPillar;
  @ValidateIf(
    (o: SubmitEvidenceDto, v: unknown) => v !== undefined || !o.catalogueId,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  pathwayType?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(150) catalogueId?: string;
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(3000) explanation?: string | null;
}
export class UpdateEvidenceDto {
  @ValidateIf((_, v: unknown) => v !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  catalogueId?: string;
  @IsOptional() @IsString() @MaxLength(3000) explanation?: string | null;
}
