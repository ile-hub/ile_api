import { Module } from '@nestjs/common';
import { LegalController, PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';
@Module({
  controllers: [LegalController, PrivacyController],
  providers: [PrivacyService],
})
export class PrivacyModule {}
