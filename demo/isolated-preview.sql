-- ISOLATED DEMO ONLY. Not a production migration. Apply using the guarded installer.
-- Additive read-only projections; no property/profile/storage policy changes.
BEGIN;
CREATE OR REPLACE FUNCTION leri_demo_preview_manifest() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public AS $$ SELECT '{"project": "leri-phase2-validation-20261014-final", "accounts": {"amina": "33144328-594b-4c09-9eeb-2913c2c39b0f", "david": "bbc84e2a-5e68-47d7-8ce2-69b218d3d550", "sarah": "b47ba3cc-7aa1-439a-9df6-b1e68fc92457", "jamie": "5271e678-d8ee-4f23-81b7-29e1dd9b0b3c", "priya": "835b4e68-5ad7-4069-ad56-e15b6cf4a063", "lewis": "56fa85f3-eb9b-4203-a763-2a7863569f36"}, "properties": {"65ed0783-8f5e-464b-9300-033a80f4aba5": "amina", "8b630e59-06f8-4c34-adf6-cee09dec0924": "amina", "cf2d559d-cecd-4009-a878-68d37a7453b1": "amina", "734630cc-320f-4b74-9c05-9fa74afd0921": "david", "61959473-5da7-48e5-a652-33ccb689f8c4": "david", "51a1b692-42c1-4cb9-be21-c552bdd6193c": "david", "7b5520c0-1f72-4006-94de-333a8cfd9bd1": "sarah"}}'::jsonb $$;
REVOKE ALL ON FUNCTION leri_demo_preview_manifest() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION leri_demo_preview_manifest() TO app_user;

CREATE OR REPLACE FUNCTION leri_demo_preview_valid() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT
 (SELECT count(*)=6 FROM jsonb_each_text(leri_demo_preview_manifest()->'accounts') a
 JOIN users u ON u.id=a.value::uuid JOIN auth.users au ON au.id=u.id
 LEFT JOIN renter_profiles rp ON rp.user_id=u.id LEFT JOIN landlord_profiles lp ON lp.user_id=u.id
 WHERE au.raw_user_meta_data->>'demo_namespace'='leri-showcase-20261029'
 AND ((a.key IN ('amina','david','sarah') AND u.role='landlord' AND lp.is_demo AND lp.discoverable)
 OR (a.key IN ('jamie','priya','lewis') AND u.role='renter' AND rp.is_demo AND rp.discoverable)))
 AND
 (SELECT count(*)=7 FROM jsonb_each_text(leri_demo_preview_manifest()->'properties') a
 JOIN properties p ON p.id=a.key::uuid
 WHERE p.landlord_id=(leri_demo_preview_manifest()->'accounts'->>a.value)::uuid
 AND p.status='draft' AND p.availability_status='available');
$$;
REVOKE ALL ON FUNCTION leri_demo_preview_valid() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION leri_demo_preview_valid() TO app_user;
DO $$ BEGIN IF NOT leri_demo_preview_valid() THEN RAISE EXCEPTION 'Refusing demo preview: exact six-account/seven-draft ownership validation failed'; END IF; END $$;

CREATE OR REPLACE FUNCTION leri_demo_preview_properties(p_landlord uuid DEFAULT NULL) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT jsonb_build_object(
 'id',p.id,'landlordId',p.landlord_id,'title',p.title,'description',p.description,
 'city',p.city,'bedrooms',p.bedrooms,'rentAmount',p.rent_amount,'currency',p.currency,
 'propertyRules',p.property_rules,'status','draft','listingStatus','demo_preview',
 'publishedAt',NULL,'archivedAt',NULL,'createdAt',p.created_at,'updatedAt',p.updated_at,
 'presentation',jsonb_build_object('mode','synthetic_demo_preview','label','Illustrative synthetic home — unpublished; compliance not checked','photosIllustrative',true),
 'details',COALESCE((SELECT jsonb_object_agg(key,value) FROM jsonb_each(p.details) WHERE key=ANY(ARRAY['publicArea','postcodeDistrict','depositAmount','billsIncluded','billsExcluded','availableFrom','minTenancyMonths','expectedTenancyMonths','propertyType','bathrooms','permittedOccupants','furnishing','keyFeatures','councilTaxBand','epcRating','hmoLicenceStatus','heating','energyFeatures','parking','outdoorSpace','accessibilityFeatures','petsPolicy','smokingPolicy','otherConditions','walkthroughUrl','walkthroughType'])),'{}'::jsonb),
 'arcsPreferences',leri_effective_arcs(p.landlord_id,p.id),
 'photos',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ph.id,'mimeType',ph.mime_type,'caption',ph.caption,'position',ph.position,'illustrative',true) ORDER BY ph.position,ph.id) FROM leri_property_photos ph WHERE ph.property_id=p.id AND ph.owner_id=p.landlord_id AND ph.removed_at IS NULL),'[]'::jsonb))
 FROM properties p JOIN jsonb_each_text(leri_demo_preview_manifest()->'properties') a ON p.id=a.key::uuid
 JOIN users caller ON caller.id=nullif(current_setting('app.current_user_id',true),'')::uuid
 WHERE current_setting('app.leri_demo_preview',true)='leri-phase2-validation-20261014-final'
 AND leri_demo_preview_valid()
 AND caller.id IN (SELECT value::uuid FROM jsonb_each_text(leri_demo_preview_manifest()->'accounts'))
 AND (caller.role='renter' OR (caller.role='landlord' AND p.landlord_id=caller.id))
 AND p.landlord_id=(leri_demo_preview_manifest()->'accounts'->>a.value)::uuid
 AND (p_landlord IS NULL OR p.landlord_id=p_landlord)
 AND p.status='draft' AND p.availability_status='available'
 ORDER BY p.id;
$$;
REVOKE ALL ON FUNCTION leri_demo_preview_properties(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION leri_demo_preview_properties(uuid) TO app_user;
CREATE OR REPLACE FUNCTION leri_demo_preview_photo_path(p_property uuid,p_photo uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT ph.object_path FROM leri_property_photos ph
 JOIN properties p ON p.id=ph.property_id
 WHERE ph.id=p_photo AND ph.property_id=p_property AND ph.owner_id=p.landlord_id
 AND ph.removed_at IS NULL AND ph.object_path=p.landlord_id::text||'/property/'||p.id::text||'/'||ph.id::text
 AND EXISTS(SELECT 1 FROM leri_demo_preview_properties(p.landlord_id) x WHERE x->>'id'=p.id::text);
$$;
REVOKE ALL ON FUNCTION leri_demo_preview_photo_path(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION leri_demo_preview_photo_path(uuid,uuid) TO app_user;
COMMIT;
