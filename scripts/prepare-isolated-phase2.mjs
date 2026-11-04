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
        "SELECT to_regclass('leri_evidence_documents') AS existing",
      )
    ).rows[0].existing
  )
    throw new Error('Phase 2 is already applied; use a fresh disposable stack');
  if (
    Number((await db.query('SELECT count(*) AS n FROM users')).rows[0].n) !== 0
  )
    throw new Error('Preparation refuses a populated database');
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
    if (!res.ok) throw new Error(`Sentinel creation failed: ${res.status}`);
    ids[role] = (await res.json()).id;
  }
  const evidence = randomUUID(),
    property = randomUUID(),
    pref = randomUUID();
  await db.query(
    "UPDATE renter_profiles SET bio='Synthetic pre-migration biography',is_demo=true WHERE user_id=$1",
    [ids.renter],
  );
  await db.query('UPDATE landlord_profiles SET is_demo=true WHERE user_id=$1', [
    ids.landlord,
  ]);
  await db.query(
    "INSERT INTO evidence_items(id,renter_id,pillar,pathway_type,payload) VALUES($1,$2,'affordability','payslip','{\"dummy\":true}')",
    [evidence, ids.renter],
  );
  await db.query(
    "INSERT INTO properties(id,landlord_id,address_line1,city,postcode,bedrooms,rent_amount) VALUES($1,$2,'SYNTHETIC PRIVATE ADDRESS','Edinburgh','EH1 1AA',2,900)",
    [property, ids.landlord],
  );
  await db.query(
    'INSERT INTO landlord_preferences(id,landlord_id,min_tenancy_length_months) VALUES($1,$2,6)',
    [pref, ids.landlord],
  );
  const legacySnapshot = async () => ({
    evidence: (
      await db.query(
        'SELECT id,renter_id,pillar,pathway_type,payload,status,created_at FROM evidence_items WHERE id=$1',
        [evidence],
      )
    ).rows[0],
    property: (
      await db.query(
        'SELECT id,landlord_id,address_line1,city,postcode,bedrooms,rent_amount,status FROM properties WHERE id=$1',
        [property],
      )
    ).rows[0],
    preference: (
      await db.query(
        'SELECT id,landlord_id,min_tenancy_length_months FROM landlord_preferences WHERE id=$1',
        [pref],
      )
    ).rows[0],
  });
  const before = await legacySnapshot();
  for (const name of [
    '20261014140000_phase2_evidence_properties.sql',
    '20261014141000_phase2_private_storage.sql',
  ])
    copyFileSync(
      resolve('supabase/migrations', name),
      resolve(workdir, 'supabase/migrations', name),
    );
  execFileSync(
    'supabase',
    ['migration', 'up', '--local', '--workdir', workdir],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (JSON.stringify(before) !== JSON.stringify(await legacySnapshot()))
    throw new Error('Historical fixture data changed');
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
  if (versions.length !== 16 || !postgis)
    throw new Error('Expected all 16 migrations and real PostGIS');
  const after = (
    await db.query(
      `SELECT jsonb_build_object('renter',(SELECT jsonb_build_object('id',user_id,'bio',bio,'name',display_name) FROM renter_profiles WHERE user_id=$1),'evidence',(SELECT to_jsonb(e) FROM evidence_items e WHERE id=$2),'property',(SELECT to_jsonb(p) FROM properties p WHERE id=$3)) AS data`,
      [ids.renter, evidence, property],
    )
  ).rows[0].data;
  writeFileSync(
    resolve(workdir, 'migration-validation.json'),
    JSON.stringify(
      {
        preserved: true,
        versions,
        postgis,
        sentinel: { ...ids, evidence, property },
        before: after,
        phase2LegacyBefore: before,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    'Applied both Phase 2 migrations locally. All 16 migrations and PostGIS present; legacy evidence, property and preferences preserved.',
  );
} finally {
  await db.end();
}
