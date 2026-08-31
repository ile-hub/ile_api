import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RlsTransactionInterceptor } from '../common/rls-transaction.interceptor';
import { EvidenceService, TrustPillar } from './evidence.service';

const VALID_PILLARS: readonly TrustPillar[] = [
  'community',
  'affordability',
  'reliability',
  'stability',
];

interface SubmitEvidenceBody {
  pillar: string;
  pathwayType: string;
  payload: unknown;
}

// NOTE: this endpoint is a stand-in to prove the auth-guard + RLS
// transaction-interceptor wiring end-to-end, ahead of the real identity
// slice (Supabase signup -> users row provisioning) that will normally be
// what puts a matching public.users/renter_profiles row in place for
// req.user.id before this route is ever hit. Until that exists, whoever
// calls this needs a users/renter_profiles row with the same id as the
// JWT's `sub` already present, or the INSERT's WITH CHECK will correctly
// reject it (renter_profiles has no row to satisfy the evidence_items FK).
@Controller('evidence')
@UseGuards(JwtAuthGuard)
@UseInterceptors(RlsTransactionInterceptor)
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  @Post()
  async submit(@Body() body: SubmitEvidenceBody) {
    if (!VALID_PILLARS.includes(body?.pillar as TrustPillar)) {
      throw new BadRequestException(
        `pillar must be one of: ${VALID_PILLARS.join(', ')}`,
      );
    }
    if (!body?.pathwayType) {
      throw new BadRequestException('pathwayType is required');
    }
    return this.evidence.submitEvidence(
      body.pillar as TrustPillar,
      body.pathwayType,
      body.payload,
    );
  }

  @Get()
  async listMine() {
    return this.evidence.listOwnEvidence();
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const item = await this.evidence.getEvidenceById(id);
    if (!item) {
      throw new NotFoundException();
    }
    return item;
  }

  // A named action, not PATCH /evidence/:id with a client-supplied status
  // field -- that's the actual mechanism restricting a renter to
  // submitted->withdrawn only. There is deliberately no route that lets a
  // caller set status to anything else.
  @Post(':id/withdraw')
  async withdraw(@Param('id') id: string) {
    const item = await this.evidence.withdrawEvidence(id);
    if (!item) {
      throw new NotFoundException();
    }
    return item;
  }
}
