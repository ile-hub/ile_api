-- Historical default privileges grant UPDATE on every new table to app_user.
-- Message RLS already denies updates; remove the unused privilege as well.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON leri_messages FROM app_user;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON leri_connections FROM app_user;
