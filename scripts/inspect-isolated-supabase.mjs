import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { isolatedSupabaseEnvironment } from './isolated-supabase-env.mjs';
const { env, workdir } = isolatedSupabaseEnvironment();
const db = new pg.Pool({ connectionString: env.E2E_ADMIN_DATABASE_URL });
try {
  const versions = (
    await db.query(
      'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
    )
  ).rows.map((r) => r.version);
  const marker = JSON.parse(
    readFileSync(resolve(workdir, 'migration-validation.json'), 'utf8'),
  );
  const data = (
    await db.query(
      `SELECT jsonb_build_object('renter', (SELECT jsonb_build_object('id',user_id,'bio',bio,'name',display_name) FROM renter_profiles WHERE user_id=$1), 'evidence', (SELECT to_jsonb(e) FROM evidence_items e WHERE id=$2), 'property', (SELECT to_jsonb(p) FROM properties p WHERE id=$3)) AS data`,
      [
        marker.sentinel.renter,
        marker.sentinel.evidence,
        marker.sentinel.property,
      ],
    )
  ).rows[0].data;
  if (JSON.stringify(data) !== JSON.stringify(marker.before))
    throw new Error('Migration sentinel changed');
  const catalogue = (
    await db.query(
      'SELECT pillar,count(*)::int AS n FROM leri_evidence_catalogue WHERE active GROUP BY pillar ORDER BY pillar',
    )
  ).rows;
  const rls = (
    await db.query(
      "SELECT relname,relrowsecurity FROM pg_class WHERE oid IN ('renter_profiles'::regclass,'landlord_profiles'::regclass,'renter_preferences'::regclass,'leri_legal_documents'::regclass,'leri_terms_acceptances'::regclass,'leri_privacy_acknowledgements'::regclass,'leri_consent_events'::regclass,'leri_evidence_catalogue'::regclass,'storage.objects'::regclass) ORDER BY relname",
    )
  ).rows;
  if (rls.some((r) => !r.relrowsecurity))
    throw new Error('Expected RLS enabled on all Phase 1 tables');
  const health = {};
  for (const [name, path, service] of [
    ['auth', '/auth/v1/health', false],
    ['jwks', '/auth/v1/.well-known/jwks.json', false],
    ['rest', '/rest/v1/', false],
    ['storage', '/storage/v1/bucket', true],
  ]) {
    const key = service ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_ANON_KEY;
    const response = await fetch(`${env.SUPABASE_URL}${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    health[name] = response.status;
    if (!response.ok) throw new Error(`Unhealthy ${name}: ${response.status}`);
  }
  console.log(
    JSON.stringify(
      {
        api: env.SUPABASE_URL,
        database: '127.0.0.1:55322/postgres',
        migrationCount: versions.length,
        phase1Migrations: versions.filter((v) => v.startsWith('20261014')),
        postgis: marker.postgis,
        sentinelPreserved: true,
        catalogue,
        rls,
        health,
      },
      null,
      2,
    ),
  );
} finally {
  await db.end();
}
