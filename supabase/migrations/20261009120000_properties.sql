-- Properties slice: the columns the landlord screens actually collect, a
-- real status lifecycle, and RLS -- properties had NO RLS until now, so
-- every app_user connection could read and write every landlord's rows.
--
-- Columns are matched to ile-app's AddEditPropertyScreen, which collects
-- address_line1/city/postcode/bedrooms/rent (all already present) plus
-- property rules (missing until now). title/description are added as
-- nullable listing copy for the renter-facing cards. Deliberately NOT
-- added, because no screen collects or shows them yet:
--   - property_type / available_from: nothing in the app asks for them.
--   - tenancy_length: already lives on landlord_preferences
--     (min_tenancy_length_months) -- it's a matching preference on
--     PropertyPreferencesScreen, not a listing attribute.
--   - pets_allowed: covered by the 'no_pets' property rule chip, so a
--     separate boolean would be a second source of truth for one fact.

-- ----------------------------------------------------------------------------
-- status: free text -> enum
-- ----------------------------------------------------------------------------
-- Verified before writing this: properties had 0 rows locally, so the
-- USING cast cannot fail on unexpected legacy values.
CREATE TYPE property_status AS ENUM ('draft', 'published', 'archived');

ALTER TABLE properties ALTER COLUMN status DROP DEFAULT;
ALTER TABLE properties
    ALTER COLUMN status TYPE property_status USING status::property_status;
ALTER TABLE properties ALTER COLUMN status SET DEFAULT 'draft';

-- ----------------------------------------------------------------------------
-- New columns
-- ----------------------------------------------------------------------------
ALTER TABLE properties
    ADD COLUMN title          text,
    ADD COLUMN description    text,
    ADD COLUMN property_rules text[] NOT NULL DEFAULT '{}',
    ADD COLUMN published_at   timestamptz,
    ADD COLUMN archived_at    timestamptz,
    ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now();

-- Slugs, not the app's display labels ("No smoking") -- copy can change
-- without a data migration. Same closed set the app offers as chips.
ALTER TABLE properties ADD CONSTRAINT properties_rules_known
    CHECK (property_rules <@ ARRAY['no_smoking', 'no_pets', 'sharers_ok']::text[]);
-- Same 0..20 range as the form's bedrooms stepper.
ALTER TABLE properties ADD CONSTRAINT properties_bedrooms_range
    CHECK (bedrooms BETWEEN 0 AND 20);
ALTER TABLE properties ADD CONSTRAINT properties_rent_positive
    CHECK (rent_amount > 0);

-- ----------------------------------------------------------------------------
-- Status transitions (DB backstop, same pattern as evidence_items)
-- ----------------------------------------------------------------------------
-- Legal: draft -> published, draft -> archived, published -> archived.
-- Nothing leaves 'archived', and nothing goes back to 'draft'. The API
-- only exposes these as named actions (POST .../publish, .../archive),
-- never a generic status setter; this trigger is what makes that hold
-- for any connection, not just the routes that exist today.
-- published_at/archived_at are stamped here rather than by the app so
-- they can't be backdated by a client-supplied value.
CREATE OR REPLACE FUNCTION properties_enforce_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'draft' AND NEW.status = 'published' THEN
        NEW.published_at := now();
        RETURN NEW;
    END IF;

    IF OLD.status IN ('draft', 'published') AND NEW.status = 'archived' THEN
        NEW.archived_at := now();
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'properties: illegal status transition % -> % (id=%)',
        OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER properties_status_transition
    BEFORE UPDATE OF status ON properties
    FOR EACH ROW
    EXECUTE FUNCTION properties_enforce_status_transition();

CREATE OR REPLACE FUNCTION properties_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER properties_touch_updated_at
    BEFORE UPDATE ON properties
    FOR EACH ROW
    EXECUTE FUNCTION properties_touch_updated_at();

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
-- Landlord: full CRUD on their own rows only. Renter: SELECT on published
-- rows only -- drafts and archived listings are invisible, not just
-- filtered out by the API.
--
-- The renter policy checks users.role rather than "anyone may see
-- published rows": another landlord has no reason to read a competitor's
-- listings through this API. users has no RLS, so this lookup is exact.
--
-- Note the knock-on effect on tenancy_interests: its policies' EXISTS
-- (SELECT ... FROM properties ...) subqueries now run under these
-- policies too. That's harmless for the landlord side (they always see
-- their own properties), and the renter side of those policies never
-- reads properties at all (renter_id = session).
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

CREATE POLICY landlord_sees_own_properties ON properties
    FOR SELECT
    USING (landlord_id = current_setting('app.current_user_id', true)::uuid);

-- New rows always start as drafts -- publishing is its own action.
CREATE POLICY landlord_inserts_own_property ON properties
    FOR INSERT
    WITH CHECK (
        landlord_id = current_setting('app.current_user_id', true)::uuid
        AND status = 'draft'
    );

-- WITH CHECK also stops a landlord handing a property to someone else by
-- rewriting landlord_id.
CREATE POLICY landlord_updates_own_property ON properties
    FOR UPDATE
    USING (landlord_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (landlord_id = current_setting('app.current_user_id', true)::uuid);

-- No DELETE route exists (archive is the user-facing action), but the
-- landlord owns the row, so the database allows it. FKs from
-- tenancy_interests/matches/landlord_preferences still block deleting a
-- property anything else refers to.
CREATE POLICY landlord_deletes_own_property ON properties
    FOR DELETE
    USING (landlord_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY renter_sees_published_properties ON properties
    FOR SELECT
    USING (
        status = 'published'
        AND EXISTS (
            SELECT 1 FROM users u
            WHERE u.id = current_setting('app.current_user_id', true)::uuid
              AND u.role = 'renter'
        )
    );

-- app_user was granted SELECT/INSERT/UPDATE only (see add_app_user_role).
-- DELETE is granted on this one table so the landlord delete policy above
-- is reachable at all.
GRANT DELETE ON properties TO app_user;
