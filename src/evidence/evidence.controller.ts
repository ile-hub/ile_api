import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { EvidenceItem } from '@yourorg/ile-shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RlsTransactionInterceptor } from '../common/rls-transaction.interceptor';
import { SubmitEvidenceDto } from './dto/submit-evidence.dto';
import { EvidenceService } from './evidence.service';

// A renter's own evidence only. The caller needs a renter_profiles row
// (created at signup by handle_new_user) for the INSERT's FK + WITH CHECK
// to accept the row; a landlord's submission is rejected by the database.
@Controller('evidence')
@UseGuards(JwtAuthGuard)
@UseInterceptors(RlsTransactionInterceptor)
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  @Post()
  async submit(@Body() body: SubmitEvidenceDto): Promise<EvidenceItem> {
    return this.evidence.submitEvidence(
      body.pillar,
      body.pathwayType,
      body.payload,
    );
  }

  @Get()
  async listMine(): Promise<EvidenceItem[]> {
    return this.evidence.listOwnEvidence();
  }

  @Get(':id')
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<EvidenceItem> {
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
  @HttpCode(200)
  async withdraw(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EvidenceItem> {
    const item = await this.evidence.withdrawEvidence(id);
    if (!item) {
      throw new NotFoundException();
    }
    return item;
  }
}
