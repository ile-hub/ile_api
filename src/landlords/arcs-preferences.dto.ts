import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsObject,
  ValidateIf,
} from 'class-validator';
import { TRUST_PILLARS } from '../evidence/dto/submit-evidence.dto';
export class ArcsPreferencesDto {
  @IsArray()
  @ArrayUnique()
  @ArrayMinSize(4)
  @ArrayMaxSize(4)
  @IsIn(TRUST_PILLARS, { each: true })
  priorityOrder!: string[];
  @IsObject() evidencePreferences!: Record<
    string,
    'accept' | 'prefer' | 'not_needed'
  >;
}
export class PropertyArcsDto {
  @IsIn(['default', 'custom']) mode!: 'default' | 'custom';
  @ValidateIf(
    (o: PropertyArcsDto, v: unknown) => o.mode === 'custom' || v !== undefined,
  )
  @IsArray()
  @ArrayUnique()
  @ArrayMinSize(4)
  @ArrayMaxSize(4)
  @IsIn(TRUST_PILLARS, { each: true })
  priorityOrder?: string[];
  @ValidateIf(
    (o: PropertyArcsDto, v: unknown) => o.mode === 'custom' || v !== undefined,
  )
  @IsObject()
  evidencePreferences?: Record<string, 'accept' | 'prefer' | 'not_needed'>;
}
export interface ArcsPreferences {
  priorityOrder: string[];
  evidencePreferences: Record<string, 'accept' | 'prefer' | 'not_needed'>;
}
