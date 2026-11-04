import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { isolatedSupabaseEnvironment } from './isolated-supabase-env.mjs';
const { env, workdir } = isolatedSupabaseEnvironment();
const db = new pg.Pool({ connectionString: env.E2E_ADMIN_DATABASE_URL });
try {
  if (
    (
      await db.query(
        "SELECT to_regclass('public.leri_legal_documents') AS existing",
      )
    ).rows[0].existing
  )
    throw new Error(
      'Phase 1 is already applied; preparation never resets an existing database',
    );
  if (
    Number(
      (await db.query('SELECT count(*) AS n FROM public.users')).rows[0].n,
    ) !== 0
  )
    throw new Error('Preparation requires the new empty disposable database');
  const ids = {};
  for (const role of ['renter', 'landlord']) {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: `migration-sentinel-${role}-${randomUUID()}@example.test`,
        password: randomUUID(),
        email_confirm: true,
        user_metadata: { role, display_name: 'Synthetic migration sentinel' },
      }),
    });
    if (!res.ok)
      throw new Error(`Auth sentinel creation failed (${res.status})`);
    ids[role] = (await res.json()).id;
  }
  const evidence = randomUUID(),
    property = randomUUID();
  await db.query(
    "UPDATE renter_profiles SET bio='Synthetic pre-migration biography' WHERE user_id=$1",
    [ids.renter],
  );
  await db.query(
    "INSERT INTO evidence_items(id,renter_id,pillar,pathway_type,payload) VALUES ($1,$2,'affordability','payslip','{\"dummy\":true}')",
    [evidence, ids.renter],
  );
  await db.query(
    "INSERT INTO properties(id,landlord_id,address_line1,city,postcode,bedrooms,rent_amount) VALUES ($1,$2,'SYNTHETIC PRIVATE ADDRESS','Edinburgh','EH1 1AA',2,900)",
    [property, ids.landlord],
  );
  const snapshot = async () =>
    (
      await db.query(
        `SELECT jsonb_build_object('renter', (SELECT jsonb_build_object('id',user_id,'bio',bio,'name',display_name) FROM renter_profiles WHERE user_id=$1), 'evidence', (SELECT to_jsonb(e) FROM evidence_items e WHERE id=$2), 'property', (SELECT to_jsonb(p) FROM properties p WHERE id=$3)) AS data`,
        [ids.renter, evidence, property],
      )
    ).rows[0].data;
  const before = await snapshot();
  const migrations = [
    '20261014130000_profile_privacy_foundations.sql',
    '20261014131000_arcs_catalogue.sql',
  ];
  for (const file of migrations)
    copyFileSync(
      resolve('supabase/migrations', file),
      resolve(workdir, 'supabase/migrations', file),
    );
  execFileSync(
    'supabase',
    ['migration', 'up', '--local', '--workdir', workdir],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (JSON.stringify(before) !== JSON.stringify(await snapshot()))
    throw new Error(
      'Pre-existing synthetic data changed across Phase 1 migrations',
    );
  const versions = (
    await db.query(
      'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
    )
  ).rows.map((r) => r.version);
  const postgis = (
    await db.query(
      "SELECT extversion FROM pg_extension WHERE extname='postgis'",
    )
  ).rows[0]?.extversion;
  if (!postgis || versions.length !== 14)
    throw new Error('Expected all 14 migrations and real PostGIS');
  writeFileSync(
    resolve(workdir, 'migration-validation.json'),
    JSON.stringify(
      {
        preserved: true,
        versions,
        postgis,
        sentinel: { ...ids, evidence, property },
        before,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `Applied both Phase 1 migrations locally; all ${versions.length} migrations recorded, PostGIS ${postgis}, synthetic existing profile/evidence/property rows preserved.`,
  );
} finally {
  await db.end();
}
