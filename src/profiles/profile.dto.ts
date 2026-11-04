import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

// Null clears an optional value; required displayName cannot be cleared.
const present = (_: unknown, value: unknown) => value !== undefined;
const nonNull = (_: unknown, value: unknown) => value != null;

export class UpdateProfileDto {
  @ValidateIf(present)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  displayName?: string;

  @ValidateIf(nonNull)
  @IsString()
  @MaxLength(2000)
  bio?: string | null;

  // Only public portrait URLs belong here; document uploads use private storage in Phase 2.
  @ValidateIf(nonNull)
  @IsUrl({
    protocols: ['https'],
    require_protocol: true,
    require_tld: true,
    disallow_auth: true,
  })
  @MaxLength(2048)
  photoUrl?: string | null;

  @ValidateIf(nonNull)
  @IsString()
  @MaxLength(100)
  currentLocation?: string | null;

  @ValidateIf(nonNull)
  @IsString()
  @MaxLength(100)
  preferredLocation?: string | null;

  @ValidateIf(nonNull)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999.99)
  budgetMin?: number | null;

  @ValidateIf(nonNull)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999.99)
  budgetMax?: number | null;

  @ValidateIf(nonNull)
  @IsDateString({ strict: true })
  @MaxLength(10)
  targetMoveDate?: string | null;

  @ValidateIf(nonNull)
  @IsInt()
  @Min(1)
  @Max(120)
  tenancyLengthMonths?: number | null;

  @ValidateIf(nonNull)
  @IsInt()
  @Min(1)
  @Max(30)
  householdSize?: number | null;

  @ValidateIf(nonNull)
  @IsIn(['single', 'couple', 'family', 'sharers'])
  householdType?: string | null;

  @ValidateIf(present)
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsIn(['pet_friendly', 'smoke_free', 'sharing'], { each: true })
  householdPreferences?: string[];

  @ValidateIf(nonNull)
  @IsString()
  @MaxLength(3000)
  personalStory?: string | null;

  @ValidateIf(nonNull)
  @IsString()
  @MaxLength(150)
  companyName?: string | null;

  @ValidateIf(nonNull)
  @IsIn(['individual', 'company', 'agent'])
  landlordType?: string | null;

  @ValidateIf(nonNull)
  @IsInt()
  @Min(0)
  @Max(100)
  lettingExperienceYears?: number | null;

  @ValidateIf(nonNull)
  @IsInt()
  @Min(0)
  @Max(100000)
  numberOfProperties?: number | null;

  @ValidateIf(present)
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @IsNotEmpty({ each: true })
  locationsCovered?: string[];

  @ValidateIf(nonNull)
  @IsString()
  @MaxLength(1000)
  communicationStyle?: string | null;

  @ValidateIf(nonNull)
  @IsString()
  @MaxLength(2000)
  lettingApproach?: string | null;

  @ValidateIf(nonNull)
  @IsString()
  @MaxLength(3000)
  tenantExpectations?: string | null;

  @ValidateIf(nonNull)
  @IsString()
  @MaxLength(3000)
  tenancySuccess?: string | null;

  @ValidateIf(present)
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(100, { each: true })
  registrationNumbers?: string[];

  @ValidateIf(nonNull)
  @IsString()
  @MaxLength(2000)
  registrationDetails?: string | null;

  @ValidateIf(present)
  @IsBoolean()
  discoverable?: boolean;
}
