import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RequestContextService } from './request-context.service';
import type { PublicProperty } from '../properties/properties.service';
import type { PublicProfile } from '../profiles/profile.types';

export const DEMO_PROJECT = 'leri-phase2-validation-20261014-final';
export const DEMO_WORKDIR = '/private/tmp/leri-supabase-phase2-20261014-final';
// Bound to the reviewed, checked-in mapping, not arbitrary configuration IDs.
export const DEMO_ALLOWLIST_HASH =
  'dc1f8c472dbcba4da0042e52b6c765be24aad7c84be5e0df51d9bc883f665776';

export function validateDemoPreviewConfig(config: ConfigService): boolean {
  const flag = config.get<string>('LERI_DEMO_PREVIEW');
  if (flag === undefined || flag === 'false') return false;
  if (flag !== 'true') throw new Error('Invalid demo-preview flag');
  const db = new URL(config.getOrThrow<string>('DATABASE_URL'));
  if (
    !['development', 'test'].includes(config.get<string>('NODE_ENV') ?? '') ||
    config.get('E2E_ISOLATED_LOCAL') !== '1' ||
    config.get('LERI_SUPABASE_TEST_WORKDIR') !== DEMO_WORKDIR ||
    config.get('SUPABASE_URL') !== 'http://127.0.0.1:55321' ||
    (db.protocol !== 'postgresql:' && db.protocol !== 'postgres:') ||
    db.hostname !== '127.0.0.1' ||
    db.port !== '55322' ||
    db.pathname !== '/postgres' ||
    db.username !== 'app_user' ||
    db.search ||
    db.hash
  )
    throw new Error('Demo preview requires the exact isolated local target');
  if (existsSync(`${DEMO_WORKDIR}/supabase/.temp/project-ref`))
    throw new Error('Linked projects cannot use demo preview');
  const toml = readFileSync(`${DEMO_WORKDIR}/supabase/config.toml`, 'utf8');
  if (!/^project_id = "leri-phase2-validation-20261014-final"$/m.test(toml))
    throw new Error('Wrong demo project');
  const path = config.getOrThrow<string>('LERI_DEMO_PREVIEW_ALLOWLIST');
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest !== DEMO_ALLOWLIST_HASH)
    throw new Error('Missing or altered demo allowlist');
  return true;
}

@Injectable()
export class DemoPreviewService implements OnModuleInit {
  private active = false;
  constructor(
    private readonly config: ConfigService,
    private readonly context: RequestContextService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}
  async onModuleInit() {
    if (!validateDemoPreviewConfig(this.config)) return;
    const result = await this.pool.query<{ valid: boolean; manifest: unknown }>(
      'SELECT leri_demo_preview_valid() AS valid, leri_demo_preview_manifest() AS manifest',
    );
    const expected = JSON.parse(
      readFileSync(
        this.config.getOrThrow<string>('LERI_DEMO_PREVIEW_ALLOWLIST'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const canonical = (value: unknown): string =>
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
            )
          : item,
      );
    if (
      !result.rows[0]?.valid ||
      canonical(result.rows[0].manifest) !== canonical(expected)
    )
      throw new Error('Installed demo allowlist missing or invalid');
    this.active = true;
  }
  get enabled() {
    return this.active;
  }
  async activateTransaction() {
    if (!this.active) return;
    if (!validateDemoPreviewConfig(this.config))
      throw new Error('Demo preview configuration was disabled');
    const client = this.context.getClient();
    const result = await client.query<{ valid: boolean }>(
      'SELECT leri_demo_preview_valid() AS valid',
    );
    if (!result.rows[0]?.valid)
      throw new Error('Demo allowlist ownership or schema invalid');
    await client.query("SELECT set_config('app.leri_demo_preview',$1,true)", [
      DEMO_PROJECT,
    ]);
  }
  async properties(landlordId?: string): Promise<PublicProperty[]> {
    if (!this.active) return [];
    const result = await this.context
      .getClient()
      .query<{ item: PublicProperty }>(
        'SELECT item FROM leri_demo_preview_properties($1) item',
        [landlordId ?? null],
      );
    return result.rows.map((r) => r.item);
  }
  async decorate<T extends PublicProfile>(profile: T): Promise<T> {
    if (!this.active || profile.kind !== 'landlord') return profile;
    const previews = await this.properties(profile.id);
    return { ...profile, properties: [...profile.properties, ...previews] };
  }
  async photoPath(propertyId: string, photoId: string): Promise<string | null> {
    if (!this.active) return null;
    const result = await this.context
      .getClient()
      .query<{ path: string | null }>(
        'SELECT leri_demo_preview_photo_path($1,$2) AS path',
        [propertyId, photoId],
      );
    return result.rows[0]?.path ?? null;
  }
  storageToken(): string {
    if (!this.active) throw new Error('Demo preview disabled');
    return this.config.getOrThrow<string>('LERI_DEMO_PREVIEW_STORAGE_KEY');
  }
}
