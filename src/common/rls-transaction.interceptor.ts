import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Pool } from 'pg';
import { firstValueFrom, from, Observable } from 'rxjs';
import { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { PG_POOL } from '../database/database.module';
import { RequestContextService } from './request-context.service';

// Transaction-per-request: checks out ONE PoolClient for the whole
// request, BEGINs on it, sets app.current_user_id as a transaction-local
// GUC via set_config(..., true), runs the handler against that same
// client (via RequestContextService/AsyncLocalStorage), then
// COMMITs/ROLLBACKs and releases.
//
// This is NOT optional plumbing -- see RequestContextService's own note.
// pg.Pool hands out any free connection per pool.query() call, and
// SET LOCAL outside an explicit transaction silently behaves like a
// session-level SET that never resets. Without a dedicated client +
// explicit BEGIN/COMMIT per request, one user's app.current_user_id can
// leak onto a pooled connection a DIFFERENT user's request picks up next.
@Injectable()
export class RlsTransactionInterceptor implements NestInterceptor {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly context: RequestContextService,
  ) {}

  intercept(
    executionContext: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const req = executionContext
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const userId = req.user?.id;

    if (!userId) {
      // No auth guard ran on this route -- nothing to scope. Anything
      // that later calls RequestContextService.getClient() throws rather
      // than silently running unscoped (fail-closed, not fail-open).
      return next.handle();
    }

    return from(this.runInTransaction(userId, next));
  }

  private async runInTransaction(
    userId: string,
    next: CallHandler,
  ): Promise<unknown> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // set_config(), not string-built `SET LOCAL app.current_user_id =
      // '${userId}'` -- set_config takes its value as a normal bound
      // parameter, so it can't be broken out of the way interpolating
      // into SET LOCAL's literal syntax could.
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_user_id',
        userId,
      ]);

      const result = await this.context.run<Promise<unknown>>(
        { client, userId },
        () => firstValueFrom(next.handle() as Observable<unknown>),
      );

      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
