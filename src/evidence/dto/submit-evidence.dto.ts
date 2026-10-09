import type {
  SubmitEvidenceRequest,
  TrustPillar,
} from '@yourorg/ile-shared-types';
import { IsIn, IsNotEmpty, IsObject, IsString } from 'class-validator';

export const TRUST_PILLARS: readonly TrustPillar[] = [
  'community',
  'affordability',
  'reliability',
  'stability',
];

export class SubmitEvidenceDto implements SubmitEvidenceRequest {
  @IsIn(TRUST_PILLARS)
  pillar!: TrustPillar;

  @IsString()
  @IsNotEmpty()
  pathwayType!: string;

  // Shape varies per pathway_type (see evidence_items.payload in
  // db/schema.sql), so only "is a JSON object" is checked here.
  @IsObject()
  payload!: Record<string, unknown>;
}
