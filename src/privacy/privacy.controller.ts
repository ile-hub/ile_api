import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RlsTransactionInterceptor } from '../common/rls-transaction.interceptor';
import {
  AcceptTermsDto,
  AcknowledgePrivacyDto,
  UpdateConsentDto,
} from './privacy.dto';
import { PrivacyService } from './privacy.service';

@Controller('legal')
export class LegalController {
  constructor(private readonly privacy: PrivacyService) {}
  @Get('documents') getDocuments() {
    return this.privacy.getDocuments();
  }
}
@Controller('me/privacy')
@UseGuards(JwtAuthGuard)
@UseInterceptors(RlsTransactionInterceptor)
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}
  @Get() getOwn() {
    return this.privacy.getOwnPrivacy();
  }
  @Post('terms-acceptance')
  @HttpCode(200)
  accept(@Body() body: AcceptTermsDto) {
    return this.privacy.acceptTerms(body.termsVersion);
  }
  @Post('notice-acknowledgement')
  @HttpCode(200)
  acknowledge(@Body() body: AcknowledgePrivacyDto) {
    return this.privacy.acknowledgePrivacy(body.privacyNoticeVersion);
  }
  @Put('consents') updateConsent(@Body() body: UpdateConsentDto) {
    return this.privacy.updateConsent(body);
  }
}
