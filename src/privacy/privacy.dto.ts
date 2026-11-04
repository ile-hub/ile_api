import {
  Equals,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
export class AcceptTermsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  termsVersion!: string;
  @Equals(true)
  accepted!: true;
}
export class AcknowledgePrivacyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  privacyNoticeVersion!: string;
  @Equals(true)
  acknowledged!: true;
}
export class UpdateConsentDto {
  @IsIn(['product_updates', 'user_research'])
  purpose!: 'product_updates' | 'user_research';
  @IsBoolean()
  granted!: boolean;
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  privacyNoticeVersion!: string;
}
