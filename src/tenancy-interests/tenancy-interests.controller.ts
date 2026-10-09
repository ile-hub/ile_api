import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { TenancyInterest } from '@yourorg/ile-shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RlsTransactionInterceptor } from '../common/rls-transaction.interceptor';
import {
  ExpressInterestDto,
  ListTenancyInterestsQueryDto,
} from './dto/tenancy-interest.dto';
import { TenancyInterestsService } from './tenancy-interests.service';

// Exactly two actions exist here, nothing else: expressing interest and
// declining. There is deliberately no generic PATCH/status-setting
// route -- same reasoning as EvidenceController's withdraw action.
@Controller('tenancy-interests')
@UseGuards(JwtAuthGuard)
@UseInterceptors(RlsTransactionInterceptor)
export class TenancyInterestsController {
  constructor(private readonly tenancyInterests: TenancyInterestsService) {}

  @Post()
  async expressInterest(
    @Body() body: ExpressInterestDto,
  ): Promise<TenancyInterest> {
    return this.tenancyInterests.expressInterest(
      body.propertyId,
      body.renterId,
    );
  }

  @Post(':id/decline')
  @HttpCode(200)
  async decline(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TenancyInterest> {
    return this.tenancyInterests.decline(id);
  }

  // Declared before ':id' so 'me' isn't parsed as an id.
  @Get('me')
  async listMine(
    @Query() query: ListTenancyInterestsQueryDto,
  ): Promise<TenancyInterest[]> {
    return this.tenancyInterests.listMine(query.status);
  }

  @Get(':id')
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TenancyInterest> {
    return this.tenancyInterests.getById(id);
  }
}
