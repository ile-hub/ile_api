-- Phase 2: additive fields/tables; historical values remain unchanged.
ALTER TABLE evidence_items ADD COLUMN catalogue_id text REFERENCES leri_evidence_catalogue(id),
  ADD COLUMN explanation text CHECK (length(explanation) <= 3000),
  ADD COLUMN deleted_at timestamptz, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX leri_active_evidence_selection ON evidence_items(renter_id,catalogue_id)
  WHERE catalogue_id IS NOT NULL AND deleted_at IS NULL AND status='submitted';
CREATE FUNCTION leri_evidence_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.renter_id<>OLD.renter_id OR NEW.id<>OLD.id OR NEW.pillar<>OLD.pillar OR NEW.created_at<>OLD.created_at) THEN
    RAISE EXCEPTION 'Evidence identity is immutable' USING ERRCODE='check_violation';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status<>'submitted' AND (NEW.payload IS DISTINCT FROM OLD.payload OR NEW.catalogue_id IS DISTINCT FROM OLD.catalogue_id OR NEW.explanation IS DISTINCT FROM OLD.explanation) THEN
    RAISE EXCEPTION 'Only submitted evidence can be edited' USING ERRCODE='check_violation';
  END IF;
  IF NEW.catalogue_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.catalogue_id IS DISTINCT FROM OLD.catalogue_id) AND NOT EXISTS(
    SELECT 1 FROM leri_evidence_catalogue WHERE id=NEW.catalogue_id AND pillar=NEW.pillar AND active
  ) THEN RAISE EXCEPTION 'Unknown or mismatched evidence option' USING ERRCODE='check_violation'; END IF;
  NEW.updated_at:=now(); RETURN NEW;
END; $$;
CREATE TRIGGER leri_evidence_write_guard BEFORE INSERT OR UPDATE ON evidence_items FOR EACH ROW EXECUTE FUNCTION leri_evidence_write_guard();
-- Profiles are shared only through safe projections, never whole applicant rows.
DROP POLICY landlord_sees_applicant_profile ON renter_profiles;

ALTER TABLE properties ADD COLUMN details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object'),
  ADD COLUMN availability_status text NOT NULL DEFAULT 'available' CHECK(availability_status IN ('available','unavailable')),
  ADD COLUMN arcs_preference_mode text NOT NULL DEFAULT 'default' CHECK(arcs_preference_mode IN ('default','custom'));
-- Keep historical draft/published/archived enum and terminal archive semantics.
-- Public listings now go through an explicit projection; raw addresses remain owner-only.
DROP POLICY renter_sees_published_properties ON properties;

ALTER TABLE landlord_preferences
  ADD COLUMN is_mvp_settings boolean NOT NULL DEFAULT false,
  ADD COLUMN priority_order text[] NOT NULL DEFAULT ARRAY['affordability','reliability','community','stability']
    CHECK(cardinality(priority_order)=4 AND priority_order @> ARRAY['affordability','reliability','community','stability']::text[]),
  ADD COLUMN evidence_preferences jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(evidence_preferences)='object');
CREATE UNIQUE INDEX leri_landlord_default_preferences ON landlord_preferences(landlord_id) WHERE is_mvp_settings AND property_id IS NULL;
CREATE UNIQUE INDEX leri_property_preferences ON landlord_preferences(landlord_id,property_id) WHERE is_mvp_settings AND property_id IS NOT NULL;
ALTER TABLE landlord_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY landlord_owns_preferences ON landlord_preferences FOR ALL
 USING(landlord_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
 WITH CHECK(landlord_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND
   (property_id IS NULL OR EXISTS(SELECT 1 FROM properties WHERE id=property_id AND landlord_id=nullif(current_setting('app.current_user_id',true),'')::uuid)));
CREATE FUNCTION leri_preference_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_each_text(NEW.evidence_preferences) p LEFT JOIN leri_evidence_catalogue c ON c.id=p.key WHERE c.id IS NULL OR p.value IS NULL OR p.value NOT IN ('accept','prefer','not_needed')) THEN
   RAISE EXCEPTION 'Unknown evidence preference' USING ERRCODE='check_violation'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER leri_preference_write_guard BEFORE INSERT OR UPDATE ON landlord_preferences FOR EACH ROW EXECUTE FUNCTION leri_preference_write_guard();

CREATE TABLE leri_evidence_documents (
 id uuid PRIMARY KEY, evidence_id uuid NOT NULL REFERENCES evidence_items(id), owner_id uuid NOT NULL REFERENCES renter_profiles(user_id),
 object_path text NOT NULL UNIQUE, original_name text NOT NULL, mime_type text NOT NULL CHECK(mime_type IN ('application/pdf','image/png','image/jpeg')),
 size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880), created_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz
);
CREATE TABLE leri_property_photos (
 id uuid PRIMARY KEY, property_id uuid NOT NULL REFERENCES properties(id), owner_id uuid NOT NULL REFERENCES landlord_profiles(user_id),
 object_path text NOT NULL UNIQUE, original_name text NOT NULL, mime_type text NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
 size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880), caption text CHECK(length(caption)<=300), position integer NOT NULL DEFAULT 0 CHECK(position BETWEEN 0 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz
);
ALTER TABLE leri_evidence_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE leri_property_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_evidence_documents ON leri_evidence_documents FOR ALL
 USING(owner_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
 WITH CHECK(owner_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND EXISTS(SELECT 1 FROM evidence_items WHERE id=evidence_id AND renter_id=owner_id)
 AND object_path=owner_id::text||'/evidence/'||evidence_id::text||'/'||id::text);
CREATE POLICY owner_property_photos ON leri_property_photos FOR ALL
 USING(owner_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
 WITH CHECK(owner_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND EXISTS(SELECT 1 FROM properties WHERE id=property_id AND landlord_id=owner_id)
 AND object_path=owner_id::text||'/property/'||property_id::text||'/'||id::text);
REVOKE ALL ON leri_evidence_documents,leri_property_photos FROM PUBLIC,anon,authenticated,app_user;
GRANT SELECT,INSERT,UPDATE ON leri_evidence_documents,leri_property_photos TO app_user;

CREATE FUNCTION leri_effective_arcs(p_landlord uuid,p_property uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('priorityOrder',COALESCE(p.priority_order,ARRAY['affordability','reliability','community','stability']::text[]),'evidencePreferences',COALESCE(p.evidence_preferences,'{}'::jsonb))
 FROM (SELECT 1) dummy LEFT JOIN LATERAL (
   SELECT pref.priority_order,pref.evidence_preferences FROM landlord_preferences pref
   WHERE pref.landlord_id=p_landlord AND pref.is_mvp_settings AND
     (pref.property_id IS NULL OR (pref.property_id=p_property AND EXISTS(SELECT 1 FROM properties WHERE id=p_property AND landlord_id=p_landlord AND arcs_preference_mode='custom')))
   ORDER BY pref.property_id NULLS LAST LIMIT 1
 ) p ON true
 WHERE EXISTS(SELECT 1 FROM users WHERE id=nullif(current_setting('app.current_user_id',true),'')::uuid AND role IN ('renter','landlord'))
 AND (p_landlord=nullif(current_setting('app.current_user_id',true),'')::uuid OR EXISTS(SELECT 1 FROM landlord_profiles WHERE user_id=p_landlord AND discoverable) OR EXISTS(SELECT 1 FROM properties WHERE landlord_id=p_landlord AND status='published' AND availability_status='available'));
$$;
CREATE FUNCTION leri_public_property(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object('id',p.id,'landlordId',p.landlord_id,'title',p.title,'description',p.description,'city',p.city,'bedrooms',p.bedrooms,'rentAmount',p.rent_amount,'currency',p.currency,'propertyRules',p.property_rules,
 'status',p.status,'listingStatus','available','publishedAt',p.published_at,'archivedAt',p.archived_at,'createdAt',p.created_at,'updatedAt',p.updated_at,
 'details',COALESCE((SELECT jsonb_object_agg(key,value) FROM jsonb_each(p.details) WHERE key=ANY(ARRAY['publicArea','postcodeDistrict','depositAmount','billsIncluded','billsExcluded','availableFrom','minTenancyMonths','expectedTenancyMonths','propertyType','bathrooms','permittedOccupants','furnishing','keyFeatures','councilTaxBand','epcRating','hmoLicenceStatus','heating','energyFeatures','parking','outdoorSpace','accessibilityFeatures','petsPolicy','smokingPolicy','otherConditions','walkthroughUrl','walkthroughType'])), '{}'::jsonb)||jsonb_build_object('publicArea',COALESCE(p.details->>'publicArea',p.city),'postcodeDistrict',COALESCE(p.details->>'postcodeDistrict',CASE WHEN upper(split_part(p.postcode,' ',1)) ~ '^[A-Z]{1,2}[0-9][0-9A-Z]?$' THEN upper(split_part(p.postcode,' ',1)) ELSE NULL END)),
 'arcsPreferences',leri_effective_arcs(p.landlord_id,p.id),
 'photos',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ph.id,'mimeType',ph.mime_type,'caption',ph.caption,'position',ph.position) ORDER BY ph.position,ph.id) FROM leri_property_photos ph WHERE ph.property_id=p.id AND ph.removed_at IS NULL),'[]'::jsonb))
 FROM properties p WHERE p.id=p_id AND p.status='published' AND p.availability_status='available'
 AND EXISTS(SELECT 1 FROM users u WHERE u.id=nullif(current_setting('app.current_user_id',true),'')::uuid AND (u.role='renter' OR (u.role='landlord' AND u.id=p.landlord_id)));
$$;
CREATE FUNCTION leri_public_properties(p_landlord uuid DEFAULT NULL,p_limit integer DEFAULT 50,p_offset integer DEFAULT 0) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT item FROM (SELECT leri_public_property(id) AS item FROM properties WHERE (p_landlord IS NULL OR landlord_id=p_landlord) AND status='published' AND availability_status='available' ORDER BY published_at DESC,id LIMIT LEAST(GREATEST(p_limit,1),101) OFFSET GREATEST(p_offset,0)) list WHERE item IS NOT NULL;
$$;
CREATE FUNCTION leri_evidence_summary(p_renter uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_agg(jsonb_build_object('pillar',strand,'status',CASE WHEN EXISTS(SELECT 1 FROM evidence_items e JOIN leri_evidence_documents d ON d.evidence_id=e.id WHERE e.renter_id=p_renter AND e.pillar::text=strand AND e.deleted_at IS NULL AND e.status<>'withdrawn' AND d.removed_at IS NULL) THEN 'Document uploaded' WHEN EXISTS(SELECT 1 FROM evidence_items e WHERE e.renter_id=p_renter AND e.pillar::text=strand AND e.deleted_at IS NULL AND e.status<>'withdrawn') THEN 'Information added' ELSE 'Not provided' END,
 'categories',COALESCE((SELECT jsonb_agg(jsonb_build_object('catalogueId',c.id,'label',COALESCE(c.label,'Other information'),'status',CASE WHEN EXISTS(SELECT 1 FROM leri_evidence_documents d WHERE d.evidence_id=e.id AND d.removed_at IS NULL) THEN 'Document uploaded' ELSE 'Information added' END) ORDER BY e.created_at,e.id) FROM evidence_items e LEFT JOIN leri_evidence_catalogue c ON c.id=e.catalogue_id WHERE e.renter_id=p_renter AND e.pillar::text=strand AND e.deleted_at IS NULL AND e.status<>'withdrawn'),'[]'::jsonb)))
 FROM unnest(ARRAY['affordability','reliability','community','stability']) strand
 WHERE p_renter=nullif(current_setting('app.current_user_id',true),'')::uuid OR (EXISTS(SELECT 1 FROM users WHERE id=nullif(current_setting('app.current_user_id',true),'')::uuid AND role='landlord') AND EXISTS(SELECT 1 FROM renter_profiles WHERE user_id=p_renter AND discoverable));
$$;
REVOKE ALL ON FUNCTION leri_effective_arcs(uuid,uuid),leri_public_property(uuid),leri_public_properties(uuid,integer,integer),leri_evidence_summary(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION leri_effective_arcs(uuid,uuid),leri_public_property(uuid),leri_public_properties(uuid,integer,integer),leri_evidence_summary(uuid) TO app_user;
CREATE OR REPLACE FUNCTION leri_public_profile(p_user_id uuid) RETURNS jsonb
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
  IF result IS NOT NULL AND target_role='renter' THEN result:=result||jsonb_build_object('evidenceSummary',leri_evidence_summary(p_user_id)); END IF;
  IF result IS NOT NULL AND target_role='landlord' THEN result:=result||jsonb_build_object('arcsPreferences',leri_effective_arcs(p_user_id),'properties',COALESCE((SELECT jsonb_agg(x) FROM leri_public_properties(p_user_id,100,0) x),'[]'::jsonb)); END IF;
  RETURN result;
END;
$$;
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
        SELECT (leri_public_property(NEW.property_id)->>'status')::property_status INTO prop_status;
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


CREATE FUNCTION leri_public_photo_path(p_property uuid,p_photo uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT object_path FROM leri_property_photos WHERE id=p_photo AND property_id=p_property AND removed_at IS NULL AND leri_public_property(p_property) IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION leri_public_photo_path(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION leri_public_photo_path(uuid,uuid) TO app_user;

CREATE FUNCTION leri_valid_property_details(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; v jsonb; n numeric;
BEGIN
 IF jsonb_typeof(d)<>'object' THEN RETURN false; END IF;
 FOR k,v IN SELECT * FROM jsonb_each(d) LOOP
  IF k<>ALL(ARRAY['privateReference','publicArea','postcodeDistrict','depositAmount','billsIncluded','billsExcluded','availableFrom','minTenancyMonths','expectedTenancyMonths','propertyType','bathrooms','permittedOccupants','furnishing','keyFeatures','councilTaxBand','epcRating','hmoLicenceStatus','hmoLicenceDetails','registrationNumbers','registrationDetails','heating','energyFeatures','parking','outdoorSpace','accessibilityFeatures','petsPolicy','smokingPolicy','otherConditions','walkthroughUrl','walkthroughType']) THEN RETURN false; END IF;
  IF k=ANY(ARRAY['billsIncluded','billsExcluded','keyFeatures','registrationNumbers','energyFeatures','accessibilityFeatures']) THEN
   IF jsonb_typeof(v)<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(v) x WHERE jsonb_typeof(x)<>'string') THEN RETURN false; END IF;
   IF k IN ('billsIncluded','billsExcluded') AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(v) x WHERE x<>ALL(ARRAY['gas','electricity','water','internet','council_tax'])) THEN RETURN false; END IF;
  ELSIF v='null'::jsonb THEN CONTINUE;
  ELSIF k=ANY(ARRAY['depositAmount','minTenancyMonths','expectedTenancyMonths','bathrooms','permittedOccupants']) THEN
   IF jsonb_typeof(v)<>'number' THEN RETURN false; END IF; n:=(v#>>'{}')::numeric;
   IF n<0 OR n>99999999.99 THEN RETURN false; END IF;
   IF k<>'depositAmount' AND n<>trunc(n) THEN RETURN false; END IF;
   IF k IN ('minTenancyMonths','expectedTenancyMonths') AND (n<1 OR n>120) THEN RETURN false; END IF;
   IF k='bathrooms' AND n>20 THEN RETURN false; END IF;
   IF k='permittedOccupants' AND (n<1 OR n>30) THEN RETURN false; END IF;
  ELSE
   IF jsonb_typeof(v)<>'string' THEN RETURN false; END IF;
  END IF;
 END LOOP;
 IF d->>'postcodeDistrict' IS NOT NULL AND d->>'postcodeDistrict'!~'^[A-Z]{1,2}[0-9][0-9A-Z]?$' THEN RETURN false; END IF;
 IF d->>'propertyType' IS NOT NULL AND d->>'propertyType'<>ALL(ARRAY['flat','house','room','studio','other']) THEN RETURN false; END IF;
 IF d->>'furnishing' IS NOT NULL AND d->>'furnishing'<>ALL(ARRAY['furnished','part_furnished','unfurnished']) THEN RETURN false; END IF;
 IF d->>'hmoLicenceStatus' IS NOT NULL AND d->>'hmoLicenceStatus'<>ALL(ARRAY['not_required','pending','licensed','unknown']) THEN RETURN false; END IF;
 IF d->>'hmoLicenceStatus'='licensed' AND COALESCE(btrim(d->>'hmoLicenceDetails'),'')='' THEN RETURN false; END IF;
 IF (d->>'minTenancyMonths')::integer>(d->>'expectedTenancyMonths')::integer THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(d->'billsIncluded','[]')) a JOIN jsonb_array_elements_text(COALESCE(d->'billsExcluded','[]')) b ON a=b) THEN RETURN false; END IF;
 IF d->>'availableFrom' IS NOT NULL THEN PERFORM (d->>'availableFrom')::date; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END; $$;
ALTER TABLE properties ADD CONSTRAINT leri_property_details_valid CHECK(leri_valid_property_details(details));
