import { DemoPreviewService } from './demo-preview.service';
import { PrivateStorageService } from './private-storage.service';
import { Global, Module } from '@nestjs/common';
import { RequestContextService } from './request-context.service';
import { RlsTransactionInterceptor } from './rls-transaction.interceptor';

@Global()
@Module({
  providers: [
    DemoPreviewService,
    RequestContextService,
    RlsTransactionInterceptor,
    PrivateStorageService,
  ],
  exports: [
    DemoPreviewService,
    RequestContextService,
    RlsTransactionInterceptor,
    PrivateStorageService,
  ],
})
export class CommonModule {}
