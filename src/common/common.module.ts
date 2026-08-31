import { Global, Module } from '@nestjs/common';
import { RequestContextService } from './request-context.service';
import { RlsTransactionInterceptor } from './rls-transaction.interceptor';

@Global()
@Module({
  providers: [RequestContextService, RlsTransactionInterceptor],
  exports: [RequestContextService, RlsTransactionInterceptor],
})
export class CommonModule {}
