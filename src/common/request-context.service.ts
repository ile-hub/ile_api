import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserRole } from '@yourorg/ile-shared-types';
import { PoolClient } from 'pg';

export interface RequestContext {
  client: PoolClient;
  userId: string;
  role?: UserRole; // filled lazily by getRole()
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

  /**
   * The caller's users.role, looked up once per request. Read from
   * public.users rather than the JWT's `role` claim -- Supabase sets that
   * claim to 'authenticated' for every signed-in user, not the app role.
   * users has no RLS, so this is exact. undefined means no users row
   * exists for the session's sub.
   */
  async getRole(): Promise<UserRole | undefined> {
    const ctx = this.storage.getStore();
    if (!ctx) {
      throw new Error(
        'RequestContextService.getRole() called outside an RLS-scoped request.',
      );
    }
    if (!('role' in ctx)) {
      const result = await ctx.client.query<{ role: UserRole }>(
        'SELECT role FROM users WHERE id = $1',
        [ctx.userId],
      );
      ctx.role = result.rows[0]?.role;
    }
    return ctx.role;
  }
}
