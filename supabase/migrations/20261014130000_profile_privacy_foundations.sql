-- Phase 1. Additive only: no existing rows/tables are removed or status values recast.
ALTER TABLE renter_profiles
  ADD COLUMN photo_url text,
  ADD COLUMN current_location text,
  ADD COLUMN target_move_date date,
  ADD COLUMN household_size integer CHECK (household_size BETWEEN 1 AND 30),
  ADD COLUMN household_preferences text[] NOT NULL DEFAULT '{}'
    CHECK (household_preferences <@ ARRAY['pet_friendly', 'smoke_free', 'sharing']::text[]),
  ADD COLUMN personal_story text,
  ADD COLUMN discoverable boolean NOT NULL DEFAULT false,
  ADD COLUMN is_demo boolean NOT NULL DEFAULT false,
  ADD COLUMN identity_status text NOT NULL DEFAULT 'unverified' CHECK (identity_status IN ('unverified', 'pending', 'verified', 'failed', 'expired')),
  ADD COLUMN identity_provider text,
  ADD COLUMN identity_check_reference text,
  ADD COLUMN identity_verified_at timestamptz,
  ADD COLUMN photo_verification_status text NOT NULL DEFAULT 'unverified' CHECK (photo_verification_status IN ('unverified', 'pending', 'verified')),
  ADD COLUMN photo_verified_at timestamptz,
  ADD CONSTRAINT renter_identity_proof CHECK (identity_status <> 'verified' OR
    (identity_provider IS NOT NULL AND btrim(identity_provider) <> '' AND identity_check_reference IS NOT NULL AND btrim(identity_check_reference) <> '' AND identity_verified_at IS NOT NULL)),
  ADD CONSTRAINT renter_photo_proof CHECK (photo_verification_status <> 'verified' OR (photo_url IS NOT NULL AND photo_verified_at IS NOT NULL));

ALTER TABLE landlord_profiles
  ADD COLUMN bio text,
  ADD COLUMN photo_url text,
  ADD COLUMN landlord_type text CHECK (landlord_type IN ('individual', 'company', 'agent')),
  ADD COLUMN letting_experience_years integer CHECK (letting_experience_years BETWEEN 0 AND 100),
  ADD COLUMN number_of_properties integer CHECK (number_of_properties BETWEEN 0 AND 100000),
  ADD COLUMN locations_covered text[] NOT NULL DEFAULT '{}',
  ADD COLUMN communication_style text,
  ADD COLUMN letting_approach text,
  ADD COLUMN tenant_expectations text,
  ADD COLUMN tenancy_success text,
  ADD COLUMN registration_numbers text[] NOT NULL DEFAULT '{}',
  ADD COLUMN registration_details text,
  ADD COLUMN registration_verification_status text NOT NULL DEFAULT 'unverified' CHECK (registration_verification_status IN ('unverified', 'pending', 'verified', 'failed', 'expired')),
  ADD COLUMN registration_check_reference text,
  ADD COLUMN registration_verified_at timestamptz,
  ADD COLUMN discoverable boolean NOT NULL DEFAULT false,
  ADD COLUMN is_demo boolean NOT NULL DEFAULT false,
  ADD COLUMN identity_status text NOT NULL DEFAULT 'unverified' CHECK (identity_status IN ('unverified', 'pending', 'verified', 'failed', 'expired')),
  ADD COLUMN identity_provider text,
  ADD COLUMN identity_check_reference text,
  ADD COLUMN identity_verified_at timestamptz,
  ADD COLUMN photo_verification_status text NOT NULL DEFAULT 'unverified' CHECK (photo_verification_status IN ('unverified', 'pending', 'verified')),
  ADD COLUMN photo_verified_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT landlord_identity_proof CHECK (identity_status <> 'verified' OR
    (identity_provider IS NOT NULL AND btrim(identity_provider) <> '' AND identity_check_reference IS NOT NULL AND btrim(identity_check_reference) <> '' AND identity_verified_at IS NOT NULL)),
  ADD CONSTRAINT landlord_registration_proof CHECK (registration_verification_status <> 'verified' OR
    (cardinality(registration_numbers) > 0 AND registration_check_reference IS NOT NULL AND btrim(registration_check_reference) <> '' AND registration_verified_at IS NOT NULL)),
  ADD CONSTRAINT landlord_photo_proof CHECK (photo_verification_status <> 'verified' OR (photo_url IS NOT NULL AND photo_verified_at IS NOT NULL));

-- Defaults are opt-in for new cross-user profile visibility. Previously stored data stays private.
-- Existing budget/location/duration fields remain in renter_preferences: no duplicate truth.
ALTER TABLE renter_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY renter_owns_preferences ON renter_preferences FOR ALL
  USING (renter_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (renter_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY renter_updates_own_profile ON renter_profiles FOR UPDATE
  USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY landlord_updates_own_profile ON landlord_profiles FOR UPDATE
  USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

-- Grant only editable columns. Auth signup's SECURITY DEFINER trigger retains its permissions.
REVOKE UPDATE ON renter_profiles, landlord_profiles FROM app_user;
GRANT UPDATE (display_name, bio, photo_url, current_location, target_move_date, household_size,
  household_preferences, personal_story, discoverable, updated_at) ON renter_profiles TO app_user;
GRANT UPDATE (display_name, company_name, bio, photo_url, landlord_type, letting_experience_years,
  number_of_properties, locations_covered, communication_style, letting_approach, tenant_expectations,
  tenancy_success, registration_numbers, registration_details, discoverable, updated_at) ON landlord_profiles TO app_user;
REVOKE INSERT ON renter_profiles FROM app_user;
GRANT INSERT (user_id, display_name, bio) ON renter_profiles TO app_user;

-- Even a trusted verification result stops applying after the associated photo/registration changes.
CREATE FUNCTION leri_profile_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.photo_url IS DISTINCT FROM OLD.photo_url THEN
    NEW.photo_verification_status := 'unverified';
    NEW.photo_verified_at := NULL;
  END IF;
  IF TG_TABLE_NAME = 'landlord_profiles' THEN
    IF NEW.registration_numbers IS DISTINCT FROM OLD.registration_numbers
       OR NEW.registration_details IS DISTINCT FROM OLD.registration_details THEN
      NEW.registration_verification_status := CASE WHEN cardinality(NEW.registration_numbers) > 0 THEN 'pending' ELSE 'unverified' END;
      NEW.registration_check_reference := NULL;
      NEW.registration_verified_at := NULL;
      -- Preserve historical status unless its underlying registration data has changed.
      NEW.verification_status := CASE WHEN cardinality(NEW.registration_numbers) > 0 THEN 'pending' ELSE 'unverified' END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER leri_renter_profile_changed BEFORE UPDATE ON renter_profiles FOR EACH ROW EXECUTE FUNCTION leri_profile_changed();
CREATE TRIGGER leri_landlord_profile_changed BEFORE UPDATE ON landlord_profiles FOR EACH ROW EXECUTE FUNCTION leri_profile_changed();

-- Explicit allowlist shared by public profile and self-preview. SECURITY DEFINER is
-- necessary for cross-user reads; it never returns the underlying private table row.
CREATE FUNCTION leri_public_profile(p_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  caller uuid := nullif(current_setting('app.current_user_id', true), '')::uuid;
  caller_role user_role;
  target_role user_role;
  result jsonb;
BEGIN
  SELECT role INTO caller_role FROM users WHERE id = caller;
  SELECT role INTO target_role FROM users WHERE id = p_user_id;
  IF caller_role NOT IN ('renter', 'landlord') OR caller_role IS NULL THEN RETURN NULL; END IF;
  IF caller <> p_user_id AND caller_role = target_role THEN RETURN NULL; END IF;
  IF target_role = 'renter' THEN
    SELECT jsonb_build_object(
      'id', rp.user_id, 'kind', 'renter', 'displayName', rp.display_name,
      'bio', rp.bio, 'photoUrl', rp.photo_url, 'personalStory', rp.personal_story,
      'preferredLocation', pref.preferred_location, 'budgetMin', pref.budget_min,
      'budgetMax', pref.budget_max, 'targetMoveDate', rp.target_move_date,
      'tenancyLengthMonths', pref.tenancy_length_months, 'householdSize', rp.household_size,
      'householdType', pref.household_type, 'householdPreferences', rp.household_preferences,
      'verification', jsonb_build_object('identityStatus', rp.identity_status,
        'photoStatus', rp.photo_verification_status, 'mode', CASE WHEN rp.is_demo THEN 'demo' ELSE 'real' END),
      'memberSince', rp.created_at
    ) INTO result FROM renter_profiles rp LEFT JOIN renter_preferences pref ON pref.renter_id = rp.user_id
    WHERE rp.user_id = p_user_id AND (rp.discoverable OR caller = p_user_id);
  ELSIF target_role = 'landlord' THEN
    SELECT jsonb_build_object(
      'id', lp.user_id, 'kind', 'landlord', 'displayName', lp.display_name,
      'companyName', lp.company_name, 'bio', lp.bio, 'photoUrl', lp.photo_url,
      'landlordType', lp.landlord_type, 'lettingExperienceYears', lp.letting_experience_years,
      'numberOfProperties', lp.number_of_properties, 'locationsCovered', lp.locations_covered,
      'communicationStyle', lp.communication_style, 'lettingApproach', lp.letting_approach,
      'tenantExpectations', lp.tenant_expectations, 'tenancySuccess', lp.tenancy_success,
      'verification', jsonb_build_object('identityStatus', lp.identity_status,
        'registrationStatus', lp.registration_verification_status, 'photoStatus', lp.photo_verification_status,
        'mode', CASE WHEN lp.is_demo THEN 'demo' ELSE 'real' END),
      'memberSince', lp.created_at
    ) INTO result FROM landlord_profiles lp WHERE lp.user_id = p_user_id AND (lp.discoverable OR caller = p_user_id);
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION leri_public_profile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION leri_public_profile(uuid) TO app_user;

CREATE FUNCTION leri_own_profile() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  caller uuid := nullif(current_setting('app.current_user_id', true), '')::uuid;
  result jsonb := leri_public_profile(caller);
BEGIN
  IF result IS NULL THEN RETURN NULL; END IF;
  IF result ->> 'kind' = 'renter' THEN
    SELECT result || jsonb_build_object('currentLocation', current_location,
      'discoverable', discoverable, 'updatedAt', updated_at)
    INTO result FROM renter_profiles WHERE user_id = caller;
  ELSE
    SELECT result || jsonb_build_object('registrationNumbers', registration_numbers,
      'registrationDetails', registration_details, 'discoverable', discoverable, 'updatedAt', updated_at)
    INTO result FROM landlord_profiles WHERE user_id = caller;
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION leri_own_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION leri_own_profile() TO app_user;

-- Content is operator-managed and immutable to API callers. No invented legal policy
-- is published by this migration. Until configured, document endpoints return 503.
CREATE TABLE leri_legal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('terms', 'privacy_notice')),
  version text NOT NULL CHECK (btrim(version) <> ''),
  title text NOT NULL,
  content text NOT NULL CHECK (btrim(content) <> ''),
  published_at timestamptz,
  demo_only boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, version)
);
CREATE TABLE leri_terms_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  document_id uuid NOT NULL REFERENCES leri_legal_documents(id),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, document_id)
);
CREATE TABLE leri_privacy_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  document_id uuid NOT NULL REFERENCES leri_legal_documents(id),
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, document_id)
);
CREATE TABLE leri_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('product_updates', 'user_research')),
  granted boolean NOT NULL,
  privacy_document_id uuid NOT NULL REFERENCES leri_legal_documents(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX leri_consent_events_user_purpose ON leri_consent_events(user_id, purpose, sequence DESC);
ALTER TABLE leri_legal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE leri_terms_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE leri_privacy_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE leri_consent_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_published_legal_documents ON leri_legal_documents FOR SELECT USING (published_at <= now());
CREATE POLICY read_own_terms_acceptances ON leri_terms_acceptances FOR SELECT USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY insert_own_terms_acceptances ON leri_terms_acceptances FOR INSERT WITH CHECK (
  user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM leri_legal_documents d WHERE d.id = document_id AND d.kind = 'terms' AND d.published_at <= now()));
CREATE POLICY read_own_privacy_acknowledgements ON leri_privacy_acknowledgements FOR SELECT USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY insert_own_privacy_acknowledgements ON leri_privacy_acknowledgements FOR INSERT WITH CHECK (
  user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM leri_legal_documents d WHERE d.id = document_id AND d.kind = 'privacy_notice' AND d.published_at <= now()));
CREATE POLICY read_own_consent_events ON leri_consent_events FOR SELECT USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY insert_own_consent_events ON leri_consent_events FOR INSERT WITH CHECK (
  user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM leri_legal_documents d WHERE d.id = privacy_document_id AND d.kind = 'privacy_notice' AND d.published_at <= now()));
-- Supabase may have automatic grants for new public tables; explicitly remove them.
REVOKE ALL ON leri_legal_documents, leri_terms_acceptances, leri_privacy_acknowledgements, leri_consent_events FROM PUBLIC, anon, authenticated, app_user;
GRANT SELECT ON leri_legal_documents TO app_user;
GRANT SELECT ON leri_terms_acceptances, leri_privacy_acknowledgements, leri_consent_events TO app_user;
GRANT INSERT (user_id, document_id) ON leri_terms_acceptances, leri_privacy_acknowledgements TO app_user;
GRANT INSERT (user_id, purpose, granted, privacy_document_id) ON leri_consent_events TO app_user;
GRANT USAGE ON SEQUENCE leri_consent_events_sequence_seq TO app_user;

-- Publication freezes a document version so acceptance always refers to the same text.
CREATE FUNCTION leri_freeze_published_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'Published legal versions are immutable; create a new version' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER leri_freeze_published_document BEFORE UPDATE OR DELETE ON leri_legal_documents
  FOR EACH ROW EXECUTE FUNCTION leri_freeze_published_document();
