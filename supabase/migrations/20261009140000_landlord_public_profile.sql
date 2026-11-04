-- Renter-facing landlord profile (GET /landlords/:id).
--
-- A narrow SECURITY DEFINER function, same pattern as
-- tenancy_interest_renter_display_name: it returns exactly the public
-- fields (id, display name, member-since) and nothing else from
-- landlord_profiles -- no company name, verification status, or anything
-- from users (email, phone). landlord_profiles' own access rules are not
-- touched.
--
-- Returns a row only when BOTH hold, so it never confirms that a landlord
-- exists beyond what a renter could already infer from the listings feed:
--   - the caller is a renter (app.current_user_id, users.role);
--   - the landlord has at least one published property.
-- Anything else -- a draft-only landlord, an unknown id, a non-renter
-- caller -- is the same empty result.
--
-- The landlord's property list is NOT part of this function: the API reads
-- it from properties directly, where the existing renter RLS policy
-- (published rows only) already applies.
CREATE OR REPLACE FUNCTION landlord_public_profile(p_landlord_id uuid)
RETURNS TABLE (id uuid, display_name text, member_since timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT lp.user_id, lp.display_name, lp.created_at
    FROM landlord_profiles lp
    WHERE lp.user_id = p_landlord_id
      AND EXISTS (
          SELECT 1 FROM users u
          WHERE u.id = nullif(current_setting('app.current_user_id', true), '')::uuid
            AND u.role = 'renter'
      )
      AND EXISTS (
          SELECT 1 FROM properties p
          WHERE p.landlord_id = lp.user_id
            AND p.status = 'published'
      );
$$;

REVOKE ALL ON FUNCTION landlord_public_profile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION landlord_public_profile(uuid) TO app_user;
