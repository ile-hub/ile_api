import { Client } from 'pg';

// Deletes every user whose email matches `emailPattern` (a SQL LIKE
// pattern), and everything they own, in FK order. Runs as the database
// owner -- app_user can't (and shouldn't be able to) delete users, and
// RLS would hide other users' rows from it anyway.
//
// public.users is not FK-linked to auth.users (see the atomic signup
// trigger migration), so both are deleted explicitly.
const PURGE_SQL = `
  CREATE TEMP TABLE purge_ids ON COMMIT DROP AS
    SELECT id FROM public.users WHERE email LIKE $1;

  DELETE FROM tenancy_interests
   WHERE renter_id IN (SELECT id FROM purge_ids)
      OR property_id IN (SELECT p.id FROM properties p
                         WHERE p.landlord_id IN (SELECT id FROM purge_ids));
  DELETE FROM evidence_items WHERE renter_id IN (SELECT id FROM purge_ids);
  DELETE FROM properties WHERE landlord_id IN (SELECT id FROM purge_ids);
  -- renter_profiles / landlord_profiles / identity_verifications cascade.
  DELETE FROM public.users WHERE id IN (SELECT id FROM purge_ids);
  DELETE FROM auth.users WHERE id IN (SELECT id FROM purge_ids);
`;

export async function purgeTestUsers(
  adminDatabaseUrl: string,
  emailPattern: string,
): Promise<number> {
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Multi-statement queries can't take bind parameters, so the pattern
    // goes through a transaction-local setting instead of string building.
    await client.query("SELECT set_config('purge.pattern', $1, true)", [
      emailPattern,
    ]);
    const count = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM public.users WHERE email LIKE current_setting('purge.pattern')",
    );
    await client.query(
      PURGE_SQL.replace('$1', "current_setting('purge.pattern')"),
    );
    await client.query('COMMIT');
    return Number(count.rows[0].n);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}
