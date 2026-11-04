-- landlord_profiles had no RLS at all: any app_user query could read every
-- landlord's full row (company_name, verification_status). No endpoint
-- exposed that, but nothing at the database stopped one from doing so --
-- unlike every other profile/trust table here.
--
-- After this, a landlord can SELECT only their own row (GET /me, the
-- REQUIRE_VERIFICATION publish check). Cross-user reads go through narrow
-- SECURITY DEFINER functions that return single public fields:
--   - landlord_public_profile()                 (GET /landlords/:id)
--   - tenancy_interest_landlord_display_name()  (below; renter's view of
--     a tenancy interest)
-- No INSERT/UPDATE/DELETE policies: rows are created only by the
-- handle_new_user() signup trigger (SECURITY DEFINER), and no endpoint
-- edits them yet. Default-deny is the intent until one does.
ALTER TABLE landlord_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY landlord_sees_own_profile ON landlord_profiles
    FOR SELECT
    USING (user_id = current_setting('app.current_user_id', true)::uuid);

-- The landlord's display name, for the RENTER on a tenancy_interests row.
-- Mirror of tenancy_interest_renter_display_name: one column, only to the
-- renter on that row, and only while the row is visible to them (same
-- declined-visibility rule as the tenancy_interests SELECT policy).
CREATE OR REPLACE FUNCTION tenancy_interest_landlord_display_name(p_interest_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT lp.display_name
    FROM tenancy_interests ti
    JOIN properties p ON p.id = ti.property_id
    JOIN landlord_profiles lp ON lp.user_id = p.landlord_id
    WHERE ti.id = p_interest_id
      AND ti.renter_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      AND (ti.status <> 'declined' OR ti.declined_by = 'renter');
$$;

REVOKE ALL ON FUNCTION tenancy_interest_landlord_display_name(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy_interest_landlord_display_name(uuid) TO app_user;
