-- Mutual matching: a NEW, human-driven concept, distinct from the
-- existing `matches` table (system-computed compatibility score only --
-- see matches' own comment in db/schema.sql). tenancy_interests tracks
-- whether a renter and a landlord have EACH independently expressed
-- interest in the same pairing; `matches` is untouched and keeps its
-- existing meaning.
CREATE TYPE tenancy_interest_status AS ENUM ('pending', 'matched', 'declined', 'withdrawn');

CREATE TABLE tenancy_interests (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    renter_id               uuid NOT NULL REFERENCES renter_profiles(user_id),
    property_id             uuid NOT NULL REFERENCES properties(id),
    renter_interested_at    timestamptz,          -- null until the renter acts
    landlord_interested_at  timestamptz,          -- null until the landlord acts
    status                  tenancy_interest_status NOT NULL DEFAULT 'pending',
    declined_by             text CHECK (declined_by IN ('renter', 'landlord')),
    matched_at               timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (renter_id, property_id)               -- one row per pair, ever
);
-- 'withdrawn' exists in the enum per spec but nothing in this migration
-- or the app reaches it -- no withdraw endpoint exists (only the two
-- actions below: express interest, decline). Same reasoning as
-- evidence_status' 'verified'/'rejected' being unreachable until a
-- reviewer module exists: flagged, not built speculatively.

-- Auto-match trigger: enforced at the DB level, not application code --
-- same reasoning as evidence_items_enforce_status_transition. A BEFORE
-- UPDATE trigger (not AFTER) so it can mutate NEW in place before the row
-- is written, rather than needing a second UPDATE statement.
--
-- Guarding on `NEW.status = 'pending'` matters: without it, a landlord
-- (or renter) touching an already-DECLINED row's timestamp (if the app
-- layer ever allowed that) could silently flip a declined pairing back
-- to 'matched' just because both timestamps happen to be non-null. This
-- trigger only ever promotes pending -> matched, never overrides a
-- decline.
CREATE OR REPLACE FUNCTION tenancy_interests_auto_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status = 'pending'
       AND NEW.renter_interested_at IS NOT NULL
       AND NEW.landlord_interested_at IS NOT NULL THEN
        NEW.status := 'matched';
        NEW.matched_at := now();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tenancy_interests_auto_match_trigger
    BEFORE UPDATE ON tenancy_interests
    FOR EACH ROW
    EXECUTE FUNCTION tenancy_interests_auto_match();

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
-- Each row is jointly "owned" by two different parties (the renter, and
-- whichever landlord owns property_id) -- unlike every other RLS policy
-- in this schema so far, which scopes to exactly one party. Every policy
-- below is an OR of both conditions, on purpose: either side may read
-- their own pairing, and either side may write to it (upsert their own
-- interest timestamp, or decline).
ALTER TABLE tenancy_interests ENABLE ROW LEVEL SECURITY;

CREATE POLICY renter_or_landlord_sees_tenancy_interest ON tenancy_interests
    FOR SELECT
    USING (
        renter_id = current_setting('app.current_user_id', true)::uuid
        OR EXISTS (
            SELECT 1 FROM properties p
            WHERE p.id = tenancy_interests.property_id
              AND p.landlord_id = current_setting('app.current_user_id', true)::uuid
        )
    );

-- Covers BOTH creation paths: a renter creating their own first row, and
-- a landlord creating a row for a specific applicant on a property they
-- own (landlord-initiated interest, before the renter has ever acted).
CREATE POLICY renter_or_landlord_inserts_tenancy_interest ON tenancy_interests
    FOR INSERT
    WITH CHECK (
        renter_id = current_setting('app.current_user_id', true)::uuid
        OR EXISTS (
            SELECT 1 FROM properties p
            WHERE p.id = property_id
              AND p.landlord_id = current_setting('app.current_user_id', true)::uuid
        )
    );

CREATE POLICY renter_or_landlord_updates_tenancy_interest ON tenancy_interests
    FOR UPDATE
    USING (
        renter_id = current_setting('app.current_user_id', true)::uuid
        OR EXISTS (
            SELECT 1 FROM properties p
            WHERE p.id = tenancy_interests.property_id
              AND p.landlord_id = current_setting('app.current_user_id', true)::uuid
        )
    )
    WITH CHECK (
        renter_id = current_setting('app.current_user_id', true)::uuid
        OR EXISTS (
            SELECT 1 FROM properties p
            WHERE p.id = tenancy_interests.property_id
              AND p.landlord_id = current_setting('app.current_user_id', true)::uuid
        )
    );
-- No DELETE policy -- rows are never deleted (decline sets status, it
-- doesn't remove the row), matching "the row still exists" in the spec.
