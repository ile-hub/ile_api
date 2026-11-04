import { Module } from '@nestjs/common';
import { PropertyTenancyInterestsController } from './property-tenancy-interests.controller';
import { TenancyInterestsController } from './tenancy-interests.controller';
import { TenancyInterestsService } from './tenancy-interests.service';

@Module({
  controllers: [TenancyInterestsController, PropertyTenancyInterestsController],
  providers: [TenancyInterestsService],
})
export class TenancyInterestsModule {}
