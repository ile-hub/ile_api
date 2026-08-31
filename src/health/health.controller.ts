import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  async check() {
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ok', db: 'ok' };
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        db: 'unreachable',
      });
    }
  }
}
