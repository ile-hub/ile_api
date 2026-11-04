import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RlsTransactionInterceptor } from '../common/rls-transaction.interceptor';
import { ListTenancyInterestsQueryDto } from './dto/tenancy-interest.dto';
import { TenancyInterestsService } from './tenancy-interests.service';

// The Applicants list: a landlord's view of one property's
// tenancy_interests rows. This is a status filter on the SAME table
// TenancyInterestsController writes to, not a separate queue/table.
@Controller('properties/:propertyId/tenancy-interests')
@UseGuards(JwtAuthGuard)
@UseInterceptors(RlsTransactionInterceptor)
export class PropertyTenancyInterestsController {
  constructor(private readonly tenancyInterests: TenancyInterestsService) {}

  @Get()
  async list(
    @Param('propertyId', ParseUUIDPipe) propertyId: string,
    @Query() query: ListTenancyInterestsQueryDto,
  ) {
    return this.tenancyInterests.listForProperty(propertyId, query.status);
  }
}
