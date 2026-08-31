-- db/schema.sql's RLS section only ever defined SELECT policies. Without
-- an INSERT policy, RLS-enabled tables default-deny ALL commands not
-- explicitly permitted -- so renters have had no way to create their own
-- renter_profiles or evidence_items rows at all under app_user. These add
-- exactly that, and only that: a renter inserting their OWN row.
--
-- WITH CHECK, not USING: USING filters which EXISTING rows a command may
-- touch; WITH CHECK constrains what a NEW row is allowed to look like.
-- INSERT only ever needs WITH CHECK -- there's no existing row to filter.

CREATE POLICY renter_inserts_own_profile ON renter_profiles
    FOR INSERT
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY renter_inserts_own_evidence ON evidence_items
    FOR INSERT
    WITH CHECK (renter_id = current_setting('app.current_user_id', true)::uuid);
