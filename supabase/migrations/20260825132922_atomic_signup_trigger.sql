-- Atomic signup: replaces any two-step "auth signup, then a separate
-- complete-signup API call" design with a single AFTER INSERT trigger on
-- auth.users. If anything in here fails, the ENTIRE signup fails --
-- including the auth.users row itself -- because this trigger fires
-- inside the same transaction Supabase Auth (GoTrue) already wraps user
-- creation in; a raised exception rolls that transaction back, not just
-- this function's own work.
--
-- Design note: public.users.id is set to auth.users.id (the SAME uuid),
-- not independently generated, even though schema.sql's users.id has a
-- gen_random_uuid() default and auth_provider_id reads as a separate
-- external-ref column. This is deliberate, not an oversight: the
-- already-built JwtAuthGuard/RlsTransactionInterceptor set
-- app.current_user_id straight from the JWT's `sub` claim (the auth uid)
-- and every RLS policy compares that directly against renter_id/user_id
-- columns. If public.users.id were a different, independently generated
-- value, no RLS policy could ever match anything for a real signed-in
-- user. auth_provider_id is still populated (with the same value) so the
-- column stays meaningful if a future multi-provider auth need ever
-- makes the two diverge.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    chosen_role text;
    chosen_display_name text;
BEGIN
    chosen_role := NEW.raw_user_meta_data ->> 'role';
    chosen_display_name := NEW.raw_user_meta_data ->> 'display_name';

    -- institution_admin and platform_admin are valid user_role enum
    -- values, but must NEVER be self-assignable via signup metadata --
    -- checked as a plain text whitelist BEFORE any cast to user_role, so
    -- both those roles and any garbage value get this exact, clear
    -- rejection rather than a generic enum-cast error.
    IF chosen_role IS NULL OR chosen_role NOT IN ('renter', 'landlord') THEN
        RAISE EXCEPTION
            'handle_new_user: role must be renter or landlord (got: %)', chosen_role
            USING ERRCODE = 'check_violation';
    END IF;

    IF chosen_display_name IS NULL OR btrim(chosen_display_name) = '' THEN
        chosen_display_name := split_part(NEW.email, '@', 1);
    END IF;

    INSERT INTO public.users (id, email, role, auth_provider_id)
    VALUES (NEW.id, NEW.email, chosen_role::user_role, NEW.id::text);

    IF chosen_role = 'renter' THEN
        INSERT INTO public.renter_profiles (user_id, display_name)
        VALUES (NEW.id, chosen_display_name);
    ELSE
        INSERT INTO public.landlord_profiles (user_id, display_name)
        VALUES (NEW.id, chosen_display_name);
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();
