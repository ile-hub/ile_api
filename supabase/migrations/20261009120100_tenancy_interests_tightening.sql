-- Tightens tenancy_interests ahead of the app switching off its in-memory
-- providers:
--   1. A declined row is visible only to the side that declined it.
--   2. A trigger enforces which party may change which column, and which
--      status transitions are legal at all.
--   3. Expressing interest requires the property to be published.
--   4. A narrow helper exposes ONLY a renter's display name to the
--      landlord on the other side of a row -- nothing else from
--      renter_profiles.

-- ----------------------------------------------------------------------------
-- 1. Declined rows: visible only to the decliner
-- ----------------------------------------------------------------------------
-- Previously both parties could always SELECT the row, and the API's
-- includeDeclined flag let a renter see that a landlord had declined
-- them (and vice versa) -- breaking "decline is silent to the other
-- party". Enforced here rather than in the API's WHERE clauses so no
-- query, current or future, can reintroduce the leak.
--
-- The UPDATE policy's USING gets the same condition: a party must not be
-- able to act on (or probe, via UPDATE ... RETURNING) a row they can't see.
DROP POLICY renter_or_landlord_sees_tenancy_interest ON tenancy_interests;
DROP POLICY renter_or_landlord_updates_tenancy_interest ON tenancy_interests;

CREATE POLICY renter_or_landlord_sees_tenancy_interest ON tenancy_interests
    FOR SELECT
    USING (
        (
            renter_id = current_setting('app.current_user_id', true)::uuid
            AND (status <> 'declined' OR declined_by = 'renter')
        )
        OR (
            EXISTS (
                SELECT 1 FROM properties p
                WHERE p.id = tenancy_interests.property_id
                  AND p.landlord_id = current_setting('app.current_user_id', true)::uuid
            )
            AND (status <> 'declined' OR declined_by = 'landlord')
        )
    );

-- WITH CHECK stays ownership-only: after a decline the row must still be
-- writable by the decliner (declined_by = their side), which the USING
-- condition above already guarantees is visible to them.
CREATE POLICY renter_or_landlord_updates_tenancy_interest ON tenancy_interests
    FOR UPDATE
    USING (
        (
            renter_id = current_setting('app.current_user_id', true)::uuid
            AND (status <> 'declined' OR declined_by = 'renter')
        )
        OR (
            EXISTS (
                SELECT 1 FROM properties p
                WHERE p.id = tenancy_interests.property_id
                  AND p.landlord_id = current_setting('app.current_user_id', true)::uuid
            )
            AND (status <> 'declined' OR declined_by = 'landlord')
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

-- ----------------------------------------------------------------------------
-- 2 + 3. Who may write what
-- ----------------------------------------------------------------------------
-- RLS answers "may this caller touch this row"; it can't answer "may the
-- RENTER set landlord_interested_at" or "is declined -> pending legal",
-- because a policy sees only one version of the row. This trigger sees
-- OLD and NEW and the caller (app.current_user_id, set per request by
-- RlsTransactionInterceptor), so it can.
--
-- Rules:
--   - id, renter_id, property_id, created_at never change.
--   - Each side may only set ITS OWN interest timestamp, only NULL ->
--     value (no rewriting, no un-setting), and only while the property
--     is published.
--   - Status transitions: pending -> matched (only with both timestamps
--     set, i.e. via tenancy_interests_auto_match), pending|matched ->
--     declined (declined_by must be the caller's own side). Nothing
--     leaves declined/withdrawn.
--   - INSERT: a new row starts pending, carrying only the inserting
--     side's timestamp.
--
-- Ordering: Postgres fires same-event BEFORE triggers alphabetically by
-- trigger name. "tenancy_interests_auto_match_trigger" sorts before
-- "tenancy_interests_enforce_write_rules", so this trigger sees NEW
-- AFTER auto-match has promoted it -- which is what lets it verify that
-- pending -> matched only ever happens with both timestamps set. Renaming
-- either trigger can silently break that; don't.
--
-- No app.current_user_id: allowed only for roles other than app_user
-- (migrations, seed scripts, the postgres role). app_user without the
-- setting is a bug in the request plumbing, so it fails closed.
CREATE OR REPLACE FUNCTION tenancy_interests_enforce_write_rules()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    caller uuid := nullif(current_setting('app.current_user_id', true), '')::uuid;
    caller_side text;
    own_col_newly_set boolean;
    prop_status property_status;
BEGIN
    IF caller IS NULL THEN
        IF current_user = 'app_user' THEN
            RAISE EXCEPTION 'tenancy_interests: app.current_user_id is not set'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND (
        NEW.id IS DISTINCT FROM OLD.id
        OR NEW.renter_id IS DISTINCT FROM OLD.renter_id
        OR NEW.property_id IS DISTINCT FROM OLD.property_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
        RAISE EXCEPTION 'tenancy_interests: id/renter_id/property_id/created_at are immutable (id=%)', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- Runs as the caller, so this lookup is itself RLS-scoped: a landlord
    -- only ever finds their own property here.
    IF caller = NEW.renter_id THEN
        caller_side := 'renter';
    ELSIF EXISTS (
        SELECT 1 FROM properties p
        WHERE p.id = NEW.property_id AND p.landlord_id = caller
    ) THEN
        caller_side := 'landlord';
    ELSE
        RAISE EXCEPTION 'tenancy_interests: caller is not a party to this pairing'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'pending' OR NEW.declined_by IS NOT NULL OR NEW.matched_at IS NOT NULL THEN
            RAISE EXCEPTION 'tenancy_interests: a new row must start pending'
                USING ERRCODE = 'check_violation';
        END IF;
        IF (caller_side = 'renter' AND (NEW.renter_interested_at IS NULL OR NEW.landlord_interested_at IS NOT NULL))
           OR (caller_side = 'landlord' AND (NEW.landlord_interested_at IS NULL OR NEW.renter_interested_at IS NOT NULL)) THEN
            RAISE EXCEPTION 'tenancy_interests: a % may only set their own interest timestamp', caller_side
                USING ERRCODE = 'check_violation';
        END IF;
        own_col_newly_set := true;
    ELSE
        IF caller_side = 'renter' THEN
            IF NEW.landlord_interested_at IS DISTINCT FROM OLD.landlord_interested_at
               OR (OLD.renter_interested_at IS NOT NULL
                   AND NEW.renter_interested_at IS DISTINCT FROM OLD.renter_interested_at) THEN
                RAISE EXCEPTION 'tenancy_interests: a renter may only set renter_interested_at, once (id=%)', OLD.id
                    USING ERRCODE = 'check_violation';
            END IF;
            own_col_newly_set := OLD.renter_interested_at IS NULL AND NEW.renter_interested_at IS NOT NULL;
        ELSE
            IF NEW.renter_interested_at IS DISTINCT FROM OLD.renter_interested_at
               OR (OLD.landlord_interested_at IS NOT NULL
                   AND NEW.landlord_interested_at IS DISTINCT FROM OLD.landlord_interested_at) THEN
                RAISE EXCEPTION 'tenancy_interests: a landlord may only set landlord_interested_at, once (id=%)', OLD.id
                    USING ERRCODE = 'check_violation';
            END IF;
            own_col_newly_set := OLD.landlord_interested_at IS NULL AND NEW.landlord_interested_at IS NOT NULL;
        END IF;
    END IF;

    IF own_col_newly_set THEN
        -- RLS-scoped again: a renter sees the property only if published,
        -- so "not found" and "not published" both land here.
        SELECT p.status INTO prop_status FROM properties p WHERE p.id = NEW.property_id;
        IF prop_status IS DISTINCT FROM 'published' THEN
            RAISE EXCEPTION 'tenancy_interests: interest can only be expressed in a published property'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF TG_OP = 'INSERT' THEN
        RETURN NEW;
    END IF;

    IF NEW.status = OLD.status THEN
        IF NEW.declined_by IS DISTINCT FROM OLD.declined_by
           OR NEW.matched_at IS DISTINCT FROM OLD.matched_at THEN
            RAISE EXCEPTION 'tenancy_interests: declined_by/matched_at change only with status (id=%)', OLD.id
                USING ERRCODE = 'check_violation';
        END IF;
        IF OLD.status IN ('declined', 'withdrawn') AND own_col_newly_set THEN
            RAISE EXCEPTION 'tenancy_interests: pairing is closed (id=%)', OLD.id
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'pending' AND NEW.status = 'matched'
       AND NEW.renter_interested_at IS NOT NULL
       AND NEW.landlord_interested_at IS NOT NULL
       AND NEW.matched_at IS NOT NULL
       AND NEW.declined_by IS NULL THEN
        RETURN NEW;
    END IF;

    IF OLD.status IN ('pending', 'matched') AND NEW.status = 'declined'
       AND NEW.declined_by = caller_side
       AND NEW.matched_at IS NOT DISTINCT FROM OLD.matched_at THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'tenancy_interests: illegal transition % -> % by % (id=%)',
        OLD.status, NEW.status, caller_side, OLD.id
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER tenancy_interests_enforce_write_rules
    BEFORE INSERT OR UPDATE ON tenancy_interests
    FOR EACH ROW
    EXECUTE FUNCTION tenancy_interests_enforce_write_rules();

-- ----------------------------------------------------------------------------
-- 4. Renter display name, for the landlord on the other side of a row
-- ----------------------------------------------------------------------------
-- renter_profiles' landlord SELECT policy only covers renters with an
-- `applications` row (an older concept), so a landlord can't read the
-- name of a renter who expressed interest. Widening that policy would
-- expose the whole renter_profiles row (date_of_birth, bio, institution)
-- at the database level; this function returns exactly one column, and
-- only when the caller is the landlord on a row they're allowed to see
-- (same declined-visibility rule as the SELECT policy above).
CREATE OR REPLACE FUNCTION tenancy_interest_renter_display_name(p_interest_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT rp.display_name
    FROM tenancy_interests ti
    JOIN properties p ON p.id = ti.property_id
    JOIN renter_profiles rp ON rp.user_id = ti.renter_id
    WHERE ti.id = p_interest_id
      AND p.landlord_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      AND (ti.status <> 'declined' OR ti.declined_by = 'landlord');
$$;

REVOKE ALL ON FUNCTION tenancy_interest_renter_display_name(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy_interest_renter_display_name(uuid) TO app_user;
