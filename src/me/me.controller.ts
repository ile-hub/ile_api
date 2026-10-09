import { Controller, Get, UseGuards, UseInterceptors } from '@nestjs/common';
import type { MeResponse } from '@yourorg/ile-shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RlsTransactionInterceptor } from '../common/rls-transaction.interceptor';
import { MeService } from './me.service';

@Controller('me')
@UseGuards(JwtAuthGuard)
@UseInterceptors(RlsTransactionInterceptor)
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  async getMe(): Promise<MeResponse> {
    return this.me.getMe();
  }
}
