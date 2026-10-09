import {
  PROPERTY_RULES,
  type CreatePropertyRequest,
  type PropertyRule,
  type UpdatePropertyRequest,
} from '@yourorg/ile-shared-types';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

// Bounds mirror the DB CHECK constraints (properties_bedrooms_range,
// properties_rent_positive, properties_rules_known) so a bad value is a
// 400 with a field message, not a 500 from a constraint violation.

export class CreatePropertyDto implements CreatePropertyRequest {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  addressLine1!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  postcode!: string;

  @IsInt()
  @Min(0)
  @Max(20)
  bedrooms!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99_999_999.99)
  rentAmount!: number;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(PROPERTY_RULES, { each: true })
  propertyRules?: PropertyRule[];
}

// Every field optional, but the NOT NULL columns can't be cleared:
// ValidateIf(v !== undefined) means "absent is fine, null is validated
// (and rejected by IsString/IsInt)". title/description use IsOptional,
// which does accept null -- clearing those is legitimate.
export class UpdatePropertyDto implements UpdatePropertyRequest {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  addressLine1?: string;

  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city?: string;

  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  postcode?: string;

  @ValidateIf((_, v) => v !== undefined)
  @IsInt()
  @Min(0)
  @Max(20)
  bedrooms?: number;

  @ValidateIf((_, v) => v !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99_999_999.99)
  rentAmount?: number;

  @ValidateIf((_, v) => v !== undefined)
  @IsArray()
  @ArrayUnique()
  @IsIn(PROPERTY_RULES, { each: true })
  propertyRules?: PropertyRule[];
}

export class PropertyFeedQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
