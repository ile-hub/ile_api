-- New person relationship, never auto-converted from historical property interests.
CREATE TABLE leri_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 introduction text NOT NULL CHECK(length(btrim(introduction)) BETWEEN 1 AND 3000),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','review_later','accepted','declined')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz,
 CHECK(sender_id<>recipient_id), CHECK((status='accepted')=(accepted_at IS NOT NULL))
);
CREATE UNIQUE INDEX leri_connection_person_pair ON leri_connections(least(sender_id,recipient_id),greatest(sender_id,recipient_id));
CREATE INDEX leri_connection_sender ON leri_connections(sender_id,id);
CREATE INDEX leri_connection_recipient ON leri_connections(recipient_id,id);
ALTER TABLE leri_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY leri_connection_participants ON leri_connections FOR SELECT TO app_user USING(nullif(current_setting('app.current_user_id',true),'')::uuid IN(sender_id,recipient_id));
CREATE POLICY leri_connection_sender_insert ON leri_connections FOR INSERT TO app_user WITH CHECK(sender_id=nullif(current_setting('app.current_user_id',true),'')::uuid);
CREATE POLICY leri_connection_recipient_update ON leri_connections FOR UPDATE TO app_user USING(recipient_id=nullif(current_setting('app.current_user_id',true),'')::uuid) WITH CHECK(recipient_id=nullif(current_setting('app.current_user_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON leri_connections TO app_user;
REVOKE ALL ON leri_connections FROM anon,authenticated;

CREATE FUNCTION leri_connection_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE caller uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; sender_role user_role; recipient_role user_role; sender_visible boolean; recipient_visible boolean;
BEGIN
 IF TG_OP='INSERT' THEN
   IF caller IS NULL OR NEW.sender_id<>caller OR NEW.sender_id=NEW.recipient_id THEN RAISE EXCEPTION 'Sender not authorised' USING ERRCODE='42501'; END IF;
   SELECT role INTO sender_role FROM users WHERE id=NEW.sender_id;
   SELECT role INTO recipient_role FROM users WHERE id=NEW.recipient_id;
   SELECT discoverable INTO sender_visible FROM (SELECT user_id,discoverable FROM renter_profiles UNION ALL SELECT user_id,discoverable FROM landlord_profiles) p WHERE user_id=NEW.sender_id;
   SELECT discoverable INTO recipient_visible FROM (SELECT user_id,discoverable FROM renter_profiles UNION ALL SELECT user_id,discoverable FROM landlord_profiles) p WHERE user_id=NEW.recipient_id;
   IF sender_role IS NULL OR recipient_role IS NULL OR sender_role NOT IN('renter','landlord') OR recipient_role NOT IN('renter','landlord') OR sender_role=recipient_role OR sender_visible IS NOT TRUE OR recipient_visible IS NOT TRUE THEN RAISE EXCEPTION 'Visible opposite-role profiles required' USING ERRCODE='42501'; END IF;
   IF NEW.status<>'pending' OR NEW.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'Requests start pending' USING ERRCODE='23514'; END IF;
   NEW.created_at:=now(); NEW.updated_at:=now();
 ELSE
   IF caller IS NULL OR caller<>OLD.recipient_id THEN RAISE EXCEPTION 'Recipient only' USING ERRCODE='42501'; END IF;
   IF NEW.id<>OLD.id OR NEW.sender_id<>OLD.sender_id OR NEW.recipient_id<>OLD.recipient_id OR NEW.introduction<>OLD.introduction OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'Immutable request fields' USING ERRCODE='42501'; END IF;
   IF OLD.status NOT IN('pending','review_later') OR NEW.status NOT IN('review_later','accepted','declined') THEN RAISE EXCEPTION 'Invalid request transition' USING ERRCODE='23514'; END IF;
   NEW.accepted_at:=CASE WHEN NEW.status='accepted' THEN now() ELSE NULL END; NEW.updated_at:=now();
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION leri_connection_guard() FROM PUBLIC;
CREATE TRIGGER leri_connection_guard BEFORE INSERT OR UPDATE ON leri_connections FOR EACH ROW EXECUTE FUNCTION leri_connection_guard();

CREATE TABLE leri_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 connection_id uuid NOT NULL REFERENCES leri_connections(id) ON DELETE CASCADE,
 sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 4000),
 sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leri_messages_thread ON leri_messages(connection_id,position);
ALTER TABLE leri_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY leri_messages_read ON leri_messages FOR SELECT TO app_user USING(EXISTS(SELECT 1 FROM leri_connections c WHERE c.id=connection_id AND c.status='accepted' AND nullif(current_setting('app.current_user_id',true),'')::uuid IN(c.sender_id,c.recipient_id)));
CREATE POLICY leri_messages_send ON leri_messages FOR INSERT TO app_user WITH CHECK(sender_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND EXISTS(SELECT 1 FROM leri_connections c WHERE c.id=connection_id AND c.status='accepted' AND leri_messages.sender_id IN(c.sender_id,c.recipient_id)));
GRANT SELECT,INSERT ON leri_messages TO app_user;
GRANT USAGE ON SEQUENCE leri_messages_position_seq TO app_user;
REVOKE ALL ON leri_messages FROM anon,authenticated;
-- Direct SQL cannot forge message history, change participants or backdate messages.
CREATE FUNCTION leri_message_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.sender_id IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid THEN RAISE EXCEPTION 'Sender only' USING ERRCODE='42501'; END IF;
 NEW.sent_at:=now(); RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION leri_message_guard() FROM PUBLIC;
CREATE TRIGGER leri_message_guard BEFORE INSERT ON leri_messages FOR EACH ROW EXECUTE FUNCTION leri_message_guard();
