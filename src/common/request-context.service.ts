import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PoolClient } from 'pg';

export interface RequestContext {
  client: PoolClient;
  userId: string;
}

// Carries the ONE PoolClient checked out for the current request through
// whatever async call chain the request handler takes, without needing
// NestJS's REQUEST-scoped DI (which re-instantiates the whole provider
// tree per request). Set by RlsTransactionInterceptor at the start of a
// request; read by anything that needs to run a query scoped to the
// current user's RLS context.
@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  run<T>(context: RequestContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  /**
   * The current request's transaction-scoped client. Throws if called
   * outside an RlsTransactionInterceptor-wrapped request -- there is
   * deliberately no fallback to the raw pool here, because silently
   * falling back would mean a query that was SUPPOSED to be RLS-scoped
   * quietly running as an unscoped connection instead.
   */
  getClient(): PoolClient {
    const ctx = this.storage.getStore();
    if (!ctx) {
      throw new Error(
        'RequestContextService.getClient() called outside an RLS-scoped request. ' +
          'Is this route missing @UseGuards(JwtAuthGuard) / the RlsTransactionInterceptor?',
      );
    }
    return ctx.client;
  }

  getUserId(): string {
    const ctx = this.storage.getStore();
    if (!ctx) {
      throw new Error(
        'RequestContextService.getUserId() called outside an RLS-scoped request.',
      );
    }
    return ctx.userId;
  }
}
