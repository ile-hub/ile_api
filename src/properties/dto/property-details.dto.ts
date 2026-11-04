import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
const BILLS = ['gas', 'electricity', 'water', 'internet', 'council_tax'];
export class PropertyDetailsDto {
  @IsOptional() @IsString() @MaxLength(100) privateReference?: string | null;
  @IsOptional() @IsString() @MaxLength(150) publicArea?: string | null;
  @IsOptional() @Matches(/^[A-Z]{1,2}[0-9][0-9A-Z]?$/) postcodeDistrict?:
    string | null;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999.99)
  depositAmount?: number | null;
  @ValidateIf((_, v: unknown) => v !== undefined)
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(5)
  @IsIn(BILLS, { each: true })
  billsIncluded?: string[];
  @ValidateIf((_, v: unknown) => v !== undefined)
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(5)
  @IsIn(BILLS, { each: true })
  billsExcluded?: string[];
  @IsOptional() @IsDateString({ strict: true }) @MaxLength(10) availableFrom?:
    string | null;
  @IsOptional() @IsInt() @Min(1) @Max(120) minTenancyMonths?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(120) expectedTenancyMonths?:
    number | null;
  @IsOptional()
  @IsIn(['flat', 'house', 'room', 'studio', 'other'])
  propertyType?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(20) bathrooms?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(30) permittedOccupants?: number | null;
  @IsOptional()
  @IsIn(['furnished', 'part_furnished', 'unfurnished'])
  furnishing?: string | null;
  @ValidateIf((_, v: unknown) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  keyFeatures?: string[];
  @IsOptional()
  @IsIn(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'exempt'])
  councilTaxBand?: string | null;
  @IsOptional()
  @IsIn(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'exempt'])
  epcRating?: string | null;
  @IsOptional()
  @IsIn(['not_required', 'pending', 'licensed', 'unknown'])
  hmoLicenceStatus?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) hmoLicenceDetails?: string | null;
  @ValidateIf((_, v: unknown) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  registrationNumbers?: string[];
  @IsOptional() @IsString() @MaxLength(2000) registrationDetails?:
    string | null;
  @IsOptional() @IsString() @MaxLength(200) heating?: string | null;
  @ValidateIf((_, v: unknown) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  energyFeatures?: string[];
  @IsOptional() @IsString() @MaxLength(200) parking?: string | null;
  @IsOptional() @IsString() @MaxLength(500) outdoorSpace?: string | null;
  @ValidateIf((_, v: unknown) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  accessibilityFeatures?: string[];
  @IsOptional() @IsIn(['allowed', 'not_allowed', 'considered']) petsPolicy?:
    string | null;
  @IsOptional() @IsIn(['allowed', 'not_allowed']) smokingPolicy?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) otherConditions?: string | null;
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true, disallow_auth: true })
  @MaxLength(2048)
  walkthroughUrl?: string | null;
  @IsOptional() @IsIn(['video', 'live']) walkthroughType?: string | null;
}
export class AvailabilityDto {
  @IsIn(['available', 'unavailable']) status!: 'available' | 'unavailable';
}
export class UpdatePhotoDto {
  @IsOptional() @IsString() @MaxLength(300) caption?: string | null;
  @ValidateIf((_, v: unknown) => v !== undefined)
  @IsInt()
  @Min(0)
  @Max(1000)
  position?: number;
}
