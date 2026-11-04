-- Dedicated private buckets. Existing buckets/objects are never repurposed.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES
 ('leri-evidence-private-v2','leri-evidence-private-v2',false,5242880,ARRAY['application/pdf','image/png','image/jpeg']),
 ('leri-property-photos-v2','leri-property-photos-v2',false,5242880,ARRAY['image/png','image/jpeg','image/webp']) ON CONFLICT(id) DO NOTHING;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM storage.buckets WHERE id IN ('leri-evidence-private-v2','leri-property-photos-v2') AND (public OR file_size_limit IS DISTINCT FROM 5242880)) THEN
  RAISE EXCEPTION 'Leri buckets must be private and bounded; refusing to repurpose existing storage'; END IF;
END $$;
CREATE FUNCTION leri_storage_allowed(p_name text,p_bucket text,p_operation text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE parts text[]:=string_to_array(p_name,'/'); caller uuid:=auth.uid(); entity uuid;
BEGIN
 IF caller IS NULL OR cardinality(parts)<>4 OR parts[1]!~'^[0-9a-f-]{36}$' OR parts[3]!~'^[0-9a-f-]{36}$' OR parts[4]!~'^[0-9a-f-]{36}$' THEN RETURN false; END IF;
 entity:=parts[3]::uuid;
 IF p_bucket='leri-evidence-private-v2' AND parts[2]='evidence' THEN
  IF parts[1]<>caller::text OR NOT EXISTS(SELECT 1 FROM evidence_items e WHERE e.id=entity AND e.renter_id=caller) THEN RETURN false; END IF;
  IF p_operation='insert' THEN RETURN EXISTS(SELECT 1 FROM evidence_items WHERE id=entity AND status='submitted' AND deleted_at IS NULL); END IF;
  IF p_operation='select' THEN RETURN EXISTS(SELECT 1 FROM leri_evidence_documents WHERE object_path=p_name AND owner_id=caller AND removed_at IS NULL); END IF;
  RETURN p_operation='delete';
 END IF;
 IF p_bucket='leri-property-photos-v2' AND parts[2]='property' THEN
  IF parts[1]=caller::text AND EXISTS(SELECT 1 FROM properties WHERE id=entity AND landlord_id=caller) THEN
    IF p_operation='insert' THEN RETURN EXISTS(SELECT 1 FROM properties WHERE id=entity AND status<>'archived'); END IF;
    RETURN p_operation IN ('select','delete');
  END IF;
  RETURN p_operation='select' AND EXISTS(SELECT 1 FROM users WHERE id=caller AND role='renter')
   AND EXISTS(SELECT 1 FROM properties p JOIN leri_property_photos ph ON ph.property_id=p.id WHERE p.id=entity AND p.landlord_id::text=parts[1] AND p.status='published' AND p.availability_status='available' AND ph.object_path=p_name AND ph.removed_at IS NULL);
 END IF;
 RETURN false;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END; $$;
REVOKE ALL ON FUNCTION leri_storage_allowed(text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION leri_storage_allowed(text,text,text) TO authenticated;
CREATE POLICY leri_private_object_insert ON storage.objects FOR INSERT TO authenticated
 WITH CHECK(leri_storage_allowed(name,bucket_id,'insert'));
CREATE POLICY leri_private_object_select ON storage.objects FOR SELECT TO authenticated
 USING(leri_storage_allowed(name,bucket_id,'select'));
CREATE POLICY leri_private_object_delete ON storage.objects FOR DELETE TO authenticated
 USING(leri_storage_allowed(name,bucket_id,'delete'));
-- No UPDATE/upsert policy: immutable unique object keys avoid overwriting another upload.
CREATE FUNCTION leri_media_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.object_path<>OLD.object_path OR NEW.original_name<>OLD.original_name OR NEW.mime_type<>OLD.mime_type OR NEW.size_bytes<>OLD.size_bytes OR NEW.created_at<>OLD.created_at OR (OLD.removed_at IS NOT NULL AND NEW.removed_at IS DISTINCT FROM OLD.removed_at) THEN
  RAISE EXCEPTION 'Media identity and removed records are immutable' USING ERRCODE='check_violation'; END IF;
 IF TG_TABLE_NAME='leri_evidence_documents' THEN
  IF NEW.evidence_id<>OLD.evidence_id THEN RAISE EXCEPTION 'Evidence link is immutable' USING ERRCODE='check_violation'; END IF;
 ELSE
  IF NEW.property_id<>OLD.property_id THEN RAISE EXCEPTION 'Property link is immutable' USING ERRCODE='check_violation'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER leri_document_identity BEFORE UPDATE ON leri_evidence_documents FOR EACH ROW EXECUTE FUNCTION leri_media_identity_guard();
CREATE TRIGGER leri_photo_identity BEFORE UPDATE ON leri_property_photos FOR EACH ROW EXECUTE FUNCTION leri_media_identity_guard();
