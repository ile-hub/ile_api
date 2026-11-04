import {
  Controller,
  Body,
  Put,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ArcsPreferencesDto } from './arcs-preferences.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RlsTransactionInterceptor } from '../common/rls-transaction.interceptor';
import {
  LandlordsService,
  type SafeLandlordPublicProfile,
} from './landlords.service';

// Renter-facing landlord profile: public fields and published listings
// only. 404 unless the landlord has at least one published property.
@Controller('landlords')
@UseGuards(JwtAuthGuard)
@UseInterceptors(RlsTransactionInterceptor)
export class LandlordsController {
  constructor(private readonly landlords: LandlordsService) {}

  @Get('me/arcs-preferences') getArcs() {
    return this.landlords.getArcs();
  }
  @Put('me/arcs-preferences') saveArcs(@Body() body: ArcsPreferencesDto) {
    return this.landlords.saveArcs(body);
  }

  @Get(':id')
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SafeLandlordPublicProfile> {
    return this.landlords.getPublicProfile(id);
  }
}
