-- ============================================================================
-- ILÉ — CORE DATA MODEL (PostgreSQL)  —  v2, corrected
-- ============================================================================
-- CHANGELOG FROM v1:
-- v1 was built before the real product model was clarified and is WRONG in
-- two structural ways this version fixes:
--   1. v1 used named pillars (Character/Affordability/References/Stability)
--      with fixed weighted-numeric columns. The real model's pillars are
--      Community/Affordability/Reliability/Stability, and — more importantly
--      — it is NOT a single weighted score. Renters submit evidence across
--      flexible pathways; each pillar resolves to a CONFIDENCE LEVEL
--      (strong/moderate/limited), not a number. v2 replaces the rigid
--      `cars_scores` columns with evidence-as-records (`evidence_items`)
--      and derived confidence summaries (`pillar_summaries`).
--   2. v1 had no representation of the compatibility matching engine at
--      all. v2 adds `renter_preferences`, `landlord_preferences`, and
--      `matches` as a genuinely separate system from trust assessment —
--      a renter can be trusted and still be a poor compatibility match,
--      and vice versa.
-- v2 also adds `identity_verifications` (KYC/right-to-rent, a hard gate
-- before evidence submission even opens) and `tenancy_outcomes` (the
-- portable trust history loop), neither of which existed in v1.
--
-- NOTE: pillar names below (community/affordability/reliability/stability)
-- are real internal values — this is the private schema, not public copy.
-- The taxonomy stays out of marketing/public-facing surfaces; it does NOT
-- need to be hidden inside your own database or backend code.
-- ============================================================================
--
-- Design principles (carried over from v1, still correct):
--
-- 1. IDENTITY IS SEPARATE FROM PROFILE. `users` only knows who someone is
--    and what role they have. It never touches evidence, financial, or
--    property data — a breach of `users` alone leaks almost nothing.
--
-- 2. EVERY TRUST SIGNAL IS EXPLAINABLE BY CONSTRUCTION. A pillar's
--    confidence level is never stored without the evidence items that
--    produced it. No black boxes.
--
-- 3. FINANCIAL DATA IS A POINTER, NOT A COPY. `financial_verifications`
--    stores a reference token to a regulated provider, never raw bank data.
--
-- 4. EVERYTHING WRITES TO audit_log, append-only.
--
-- 5. ROW-LEVEL SECURITY ENFORCES VISIBILITY, NOT JUST APP CODE.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- EXTENSIONS — required before the types/tables below that depend on them
-- ----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid() on some managed Postgres providers
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email column on users
CREATE EXTENSION IF NOT EXISTS postgis;    -- geography(Point, 4326) on properties.location


-- ----------------------------------------------------------------------------
-- IDENTITY
-- ----------------------------------------------------------------------------

CREATE TYPE user_role AS ENUM ('renter', 'landlord', 'institution_admin', 'platform_admin');

CREATE TABLE users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email               citext UNIQUE NOT NULL,
    phone               text,
    role                user_role NOT NULL,
    auth_provider_id    text,               -- external ref (Supabase Auth / Auth0 sub)
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- IDENTITY VERIFICATION (KYC / right-to-rent) — NEW in v2
-- ----------------------------------------------------------------------------
-- This is a hard gate: no evidence_items can be meaningfully submitted
-- until a renter has a 'verified' row here. Distinct from institution
-- affiliation verification below — this is "are you who you say you are
-- and allowed to rent," not "are you a student at this university."

CREATE TYPE identity_verification_status AS ENUM ('pending', 'verified', 'failed', 'expired');

CREATE TABLE identity_verifications (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    renter_id           uuid NOT NULL,        -- FK to renter_profiles(user_id) added further below,
                                               -- once that table exists (see the deferred ALTER TABLE
                                               -- right after renter_profiles' definition) -- deliberately
                                               -- NOT users(id): right_to_rent_confirmed only ever makes
                                               -- sense for a renter, so the FK target makes a landlord
                                               -- row here structurally impossible, not just unused by
                                               -- convention.
    provider            text NOT NULL,        -- 'onfido' | 'veriff' etc.
    provider_reference   text NOT NULL,        -- opaque token/check id from the provider
    status              identity_verification_status NOT NULL DEFAULT 'pending',
    right_to_rent_confirmed boolean NOT NULL DEFAULT false,
    verified_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);
-- Reasoning: like financial data, identity documents themselves are never
-- stored here — `provider_reference` points at the KYC provider's record.
-- `right_to_rent_confirmed` is tracked as its own flag because it's a
-- distinct legal check from "is this a real person," even though the
-- same provider often does both in one flow.


-- ----------------------------------------------------------------------------
-- INSTITUTIONS (universities / agents) — student affiliation, not identity
-- ----------------------------------------------------------------------------

CREATE TABLE institutions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                text NOT NULL,
    email_domain        text NOT NULL,
    sso_metadata_url    text,
    country             text NOT NULL,
    pilot_status        text NOT NULL DEFAULT 'pending', -- pending | active | paused
    billing_account_id  text,                -- B2B invoicing reference, NOT app-store IAP
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE institution_verifications (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    institution_id      uuid NOT NULL REFERENCES institutions(id),
    method              text NOT NULL,       -- 'email_domain' | 'sso_assertion' | 'manual'
    sso_assertion_id    text,
    verified_at         timestamptz,
    expires_at          timestamptz,         -- re-verify per academic year
    created_at          timestamptz NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- RENTER / LANDLORD PROFILES
-- ----------------------------------------------------------------------------

CREATE TABLE renter_profiles (
    user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name        text NOT NULL,
    date_of_birth       date,
    institution_id      uuid REFERENCES institutions(id),
    bio                 text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Still no evidence/trust/financial fields here — those stay in their own
-- tables so a landlord querying "renter profiles" structurally cannot pull
-- sensitive data in the same join without explicit separate access.

ALTER TABLE identity_verifications ADD CONSTRAINT identity_verifications_renter_id_fkey
    FOREIGN KEY (renter_id) REFERENCES renter_profiles(user_id) ON DELETE CASCADE;

CREATE TABLE landlord_profiles (
    user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name        text NOT NULL,
    company_name        text,
    verification_status text NOT NULL DEFAULT 'unverified',
    created_at          timestamptz NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- ATOMIC SIGNUP — single trigger on Supabase's auth.users, not a two-step
-- "auth signup, then a separate complete-signup API call" design
-- ----------------------------------------------------------------------------
-- public.users / renter_profiles / landlord_profiles rows are created by a
-- SECURITY DEFINER trigger function (handle_new_user) firing AFTER INSERT
-- ON auth.users, inside the SAME transaction Supabase Auth (GoTrue) already
-- wraps user creation in. If the function raises, the whole signup rolls
-- back, including the auth.users row -- there is no code path that can
-- leave an auth.users row without a matching public.users/profile row, or
-- vice versa.
--
-- Reads `role` and `display_name` out of auth.users.raw_user_meta_data
-- (the `data` object passed to Supabase's signUp() call). `role` is
-- checked against an explicit whitelist ('renter' | 'landlord') BEFORE
-- any cast to the user_role enum -- institution_admin and platform_admin
-- are valid enum values but must never be self-assignable via signup
-- metadata, so anything outside the whitelist is rejected with a clear
-- exception rather than a generic enum-cast error. `display_name` falls
-- back to the email's local part (split_part(email, '@', 1)) if omitted.
--
-- public.users.id is set to auth.users.id (the SAME uuid), not an
-- independently generated one, even though users.id above has its own
-- gen_random_uuid() default and auth_provider_id reads as a separate
-- external-ref column. This is deliberate: JwtAuthGuard/
-- RlsTransactionInterceptor (application layer) set app.current_user_id
-- straight from the signed-in JWT's `sub` claim -- the auth uid -- and
-- every RLS policy in this file compares that directly against
-- renter_id/user_id columns. If public.users.id diverged from the auth
-- uid, no RLS policy could ever match a real signed-in user.
-- auth_provider_id is still populated (with that same value) so the
-- column stays meaningful if a future multi-provider auth need ever
-- makes the two diverge.
--
-- SECURITY DEFINER + SET search_path = public: the function must run
-- with elevated privileges (it writes to public.users/renter_profiles/
-- landlord_profiles regardless of who's signing up, and RLS's INSERT
-- policies on those tables have no session context to satisfy during a
-- raw auth signup event), and a fixed search_path is standard hardening
-- for SECURITY DEFINER functions against search_path-based attacks.
--
-- Unlike the evidence_items trigger above, the literal CREATE
-- FUNCTION/CREATE TRIGGER SQL is deliberately NOT reproduced here: it
-- targets auth.users, which only exists in an already-provisioned
-- Supabase database, not a vanilla Postgres+PostGIS instance. Every other
-- statement in this file applies cleanly to a fresh scratch database
-- (verified when this file was last changed); inlining this trigger
-- would break that. See the migration for the actual implementation --
-- this block documents the design it implements.


-- ============================================================================
-- TRUST ASSESSMENT — evidence-as-records, confidence not a score
-- ============================================================================
-- This whole block replaces v1's `cars_scores` / `score_factors` tables.

CREATE TYPE trust_pillar AS ENUM ('community', 'affordability', 'reliability', 'stability');
CREATE TYPE evidence_status AS ENUM ('submitted', 'verified', 'rejected', 'withdrawn');
CREATE TYPE pillar_confidence AS ENUM ('limited', 'moderate', 'strong');

CREATE TABLE evidence_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    renter_id           uuid NOT NULL REFERENCES renter_profiles(user_id),
    pillar              trust_pillar NOT NULL,
    pathway_type        text NOT NULL,        -- e.g. 'payslip' | 'university_enrolment' | 'landlord_reference'
    payload             jsonb NOT NULL,        -- flexible shape per pathway_type
    status              evidence_status NOT NULL DEFAULT 'submitted',
    file_storage_ref     text,                 -- pointer into S3/Supabase Storage, if a document was uploaded
    verified_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);
-- Reasoning: one row per submitted item, not fixed columns per pillar —
-- this is what makes the model genuinely flexible. `payload` is JSONB
-- because a payslip, a reference letter, and an enrolment confirmation
-- each carry different shaped data, and we don't want a schema migration
-- every time a new pathway_type is introduced. `file_storage_ref` is a
-- pointer, same principle as financial_verifications below — the actual
-- file lives in object storage, not the database.

-- Status-transition guard: RLS's UPDATE policy on evidence_items (below,
-- in ROW LEVEL SECURITY) only enforces OWNERSHIP -- it can't express
-- "old status was X and new status is Y" in one predicate, since a
-- policy's USING sees only the pre-update row and WITH CHECK only the
-- post-update row. A trigger is the only mechanism with access to both,
-- so it's what actually enforces WHICH transitions are legal.
--
-- Only ONE transition is legal today: submitted -> withdrawn (a renter
-- withdrawing their own evidence). Nothing else is permitted, including
-- into 'verified'/'rejected' -- there is no reviewer role or
-- evidence-review module yet (see the "APPLICATION ROLE" section's note
-- on trust_engine_service for the same reasoning applied elsewhere).
-- When that module gets designed, its legal transitions get added here,
-- in a dedicated migration -- not guessed at in advance.
CREATE OR REPLACE FUNCTION evidence_items_enforce_status_transition()
RETURNS trigger AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW; -- not a transition (e.g. an update touching other columns)
    END IF;

    IF OLD.status = 'submitted' AND NEW.status = 'withdrawn' THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'evidence_items: illegal status transition % -> % (id=%)',
        OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_items_status_transition
    BEFORE UPDATE OF status ON evidence_items
    FOR EACH ROW
    EXECUTE FUNCTION evidence_items_enforce_status_transition();

CREATE TABLE trust_profiles (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    renter_id           uuid NOT NULL REFERENCES renter_profiles(user_id),
    algorithm_version   text NOT NULL,        -- e.g. 'rules-v1' — track which logic produced this
    risk_indicators      text[] NOT NULL DEFAULT '{}',
    suitability_insights  text[] NOT NULL DEFAULT '{}',
    generated_at         timestamptz NOT NULL DEFAULT now(),
    superseded_at         timestamptz           -- null = current profile; else historical
);
-- Reasoning: this is the top-level "generation" of a trust profile, still
-- append-only like v1's scores (new row + superseded_at, never UPDATE).
-- What's different: there's no numeric total here at all — the substance
-- of the profile is in `pillar_summaries` below plus the qualitative
-- risk/suitability text, not a single figure.

CREATE TABLE pillar_summaries (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trust_profile_id       uuid NOT NULL REFERENCES trust_profiles(id) ON DELETE CASCADE,
    pillar                trust_pillar NOT NULL,
    confidence            pillar_confidence NOT NULL,
    contributing_item_ids   uuid[] NOT NULL DEFAULT '{}',  -- evidence_items.id values behind this confidence level
    UNIQUE (trust_profile_id, pillar)
);
-- Reasoning: this is the single most important table for defensibility.
-- Every confidence level must trace back to specific evidence_items —
-- `contributing_item_ids` makes that traceable and is exactly what you'd
-- show a renter who asks "why is my Affordability only Moderate."

CREATE TABLE profile_disputes (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    renter_id           uuid NOT NULL REFERENCES renter_profiles(user_id),
    trust_profile_id      uuid NOT NULL REFERENCES trust_profiles(id),
    reason              text NOT NULL,
    status              text NOT NULL DEFAULT 'open', -- open | under_review | resolved | rejected
    resolved_by          uuid REFERENCES users(id),   -- must be a real human, enforced in application logic
    resolution_notes      text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    resolved_at          timestamptz
);
-- Reasoning: unchanged in spirit from v1 — this table's existence is what
-- makes "automated assessment" defensible as "automated assessment with a
-- real human review path," which matters under GDPR Art. 22-style rules.


-- ----------------------------------------------------------------------------
-- FINANCIAL VERIFICATION — pointer only, never raw data (unchanged from v1)
-- ----------------------------------------------------------------------------

CREATE TABLE financial_verifications (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    renter_id           uuid NOT NULL REFERENCES renter_profiles(user_id),
    provider            text NOT NULL,        -- 'plaid' | 'truelayer' | 'experian_rental_exchange'
    provider_reference   text NOT NULL,
    verification_status  text NOT NULL,        -- pending | verified | failed
    verified_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);
-- An affordability evidence_item typically references one of these rows
-- inside its JSONB payload (e.g. { "financial_verification_id": "..." })
-- rather than duplicating financial data into evidence_items directly.


-- ============================================================================
-- COMPATIBILITY MATCHING — entirely new in v2, absent from v1
-- ============================================================================
-- Deliberately independent of trust assessment. A renter's trust profile
-- and their compatibility with a given property are computed separately
-- and can disagree — trusted-but-not-a-fit is a valid, expected outcome.

CREATE TABLE renter_preferences (
    renter_id           uuid PRIMARY KEY REFERENCES renter_profiles(user_id),
    budget_min           numeric(10,2),
    budget_max           numeric(10,2),
    preferred_location    text,
    tenancy_length_months  int,
    household_type        text,          -- e.g. 'single' | 'couple' | 'family' | 'sharers'
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE landlord_preferences (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    landlord_id            uuid NOT NULL REFERENCES landlord_profiles(user_id),
    property_id            uuid,          -- nullable: a landlord may set defaults before any property exists
    min_tenancy_length_months int,
    household_type_preference text,
    property_rules          text[] NOT NULL DEFAULT '{}',
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE matches (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    renter_id              uuid NOT NULL REFERENCES renter_profiles(user_id),
    property_id            uuid NOT NULL,   -- references properties(id), FK added below after properties exists
    compatibility_score     numeric(5,2) NOT NULL,  -- 0-100, weighted-overlap output — fine to be numeric here,
                                                     -- this is NOT the trust profile, no explainability
                                                     -- requirement of the same kind applies
    match_reasons           text[] NOT NULL DEFAULT '{}',
    computed_at             timestamptz NOT NULL DEFAULT now()
);
-- Reasoning: note the asymmetry with trust_profiles on purpose — a
-- compatibility score CAN be a single number, because it's a preference-
-- overlap calculation, not a decision gating someone's access to housing
-- in the same legally sensitive way a trust assessment is. Don't blur
-- these two systems' design rules together.


-- ----------------------------------------------------------------------------
-- PROPERTIES & APPLICATIONS
-- ----------------------------------------------------------------------------

CREATE TABLE properties (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    landlord_id         uuid NOT NULL REFERENCES landlord_profiles(user_id),
    address_line1        text NOT NULL,
    city                text NOT NULL,
    postcode            text NOT NULL,
    location             geography(Point, 4326),
    bedrooms            int NOT NULL,
    rent_amount          numeric(10,2) NOT NULL,
    currency            text NOT NULL DEFAULT 'GBP',
    status              text NOT NULL DEFAULT 'draft',
    created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE matches ADD CONSTRAINT matches_property_fk
    FOREIGN KEY (property_id) REFERENCES properties(id);
ALTER TABLE landlord_preferences ADD CONSTRAINT landlord_prefs_property_fk
    FOREIGN KEY (property_id) REFERENCES properties(id);

CREATE TABLE applications (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    renter_id           uuid NOT NULL REFERENCES renter_profiles(user_id),
    property_id         uuid NOT NULL REFERENCES properties(id),
    status              text NOT NULL DEFAULT 'submitted', -- submitted | shortlisted | rejected | accepted | withdrawn
    trust_profile_id      uuid REFERENCES trust_profiles(id), -- profile AS SEEN at time of application
    match_id             uuid REFERENCES matches(id),        -- compatibility AS SEEN at time of application
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Reasoning: both trust_profile_id and match_id are snapshots, same logic
-- as v1's score_snapshot_id — even if either changes later, you can
-- always reconstruct exactly what the landlord saw when they decided.


-- ----------------------------------------------------------------------------
-- TENANCY OUTCOMES — NEW in v2, the portable trust history loop
-- ----------------------------------------------------------------------------

CREATE TABLE tenancy_outcomes (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id        uuid NOT NULL REFERENCES applications(id),
    recorded_by_role       user_role NOT NULL,   -- 'renter' or 'landlord' — both sides record independently
    recorded_by_user_id     uuid NOT NULL REFERENCES users(id),
    completed_successfully  boolean,
    notes                 text,
    recorded_at            timestamptz NOT NULL DEFAULT now()
);
-- Reasoning: this is the table that makes trust "portable" in the sense
-- the product actually promises — a completed tenancy's outcome should
-- feed into future evidence for the renter (and, longer term, a track
-- record for the landlord too). Both sides record independently rather
-- than a single shared row, since a renter and landlord may not agree on
-- how a tenancy went, and that disagreement is itself worth capturing
-- rather than forcing false consensus into one field.


-- ----------------------------------------------------------------------------
-- SUBSCRIPTIONS — B2C and B2B deliberately separate (unchanged from v1)
-- ----------------------------------------------------------------------------

CREATE TABLE subscriptions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    billing_type         text NOT NULL,        -- 'b2c' | 'b2b_institution'
    user_id             uuid REFERENCES users(id),
    institution_id       uuid REFERENCES institutions(id),
    plan                text NOT NULL,
    status              text NOT NULL,
    provider_reference   text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT one_billing_target CHECK (
        (billing_type = 'b2c' AND user_id IS NOT NULL AND institution_id IS NULL) OR
        (billing_type = 'b2b_institution' AND institution_id IS NOT NULL AND user_id IS NULL)
    )
);


-- ----------------------------------------------------------------------------
-- AUDIT LOG — immutable trail (unchanged from v1)
-- ----------------------------------------------------------------------------

CREATE TABLE audit_log (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id             uuid REFERENCES users(id),
    action              text NOT NULL,         -- 'trust_profile.generate' | 'dispute.resolve' | 'evidence.submit' etc.
    entity_type          text NOT NULL,
    entity_id            uuid NOT NULL,
    metadata             jsonb,
    created_at          timestamptz NOT NULL DEFAULT now()
);
-- Application code should INSERT here, never UPDATE or DELETE. Revoke
-- UPDATE/DELETE grants on this table at the database role level.


-- ============================================================================
-- ROW-LEVEL SECURITY
-- ============================================================================

ALTER TABLE renter_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE pillar_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY renter_sees_own_profile ON renter_profiles
    FOR SELECT
    USING (user_id = current_setting('app.current_user_id', true)::uuid);

-- A landlord can see a renter's profile ONLY if that renter has an
-- active application to one of the landlord's properties.
CREATE POLICY landlord_sees_applicant_profile ON renter_profiles
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM applications a
            JOIN properties p ON p.id = a.property_id
            WHERE a.renter_id = renter_profiles.user_id
              AND p.landlord_id = current_setting('app.current_user_id', true)::uuid
              AND a.status != 'withdrawn'
        )
    );

-- WITH CHECK, not USING: a renter INSERTing has no existing row to filter,
-- only a new one to constrain the shape of.
CREATE POLICY renter_inserts_own_profile ON renter_profiles
    FOR INSERT
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY renter_sees_own_trust_profile ON trust_profiles
    FOR SELECT
    USING (renter_id = current_setting('app.current_user_id', true)::uuid);

-- Landlords see the SNAPSHOT trust profile tied to an application, not a
-- live-updating one — enforced by querying through applications.trust_profile_id
-- in the application layer; this RLS policy still scopes it to real applicants.
CREATE POLICY landlord_sees_applicant_trust_profile ON trust_profiles
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM applications a
            JOIN properties p ON p.id = a.property_id
            WHERE a.trust_profile_id = trust_profiles.id
              AND p.landlord_id = current_setting('app.current_user_id', true)::uuid
        )
    );

CREATE POLICY renter_sees_own_pillar_summaries ON pillar_summaries
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM trust_profiles tp
            WHERE tp.id = pillar_summaries.trust_profile_id
              AND tp.renter_id = current_setting('app.current_user_id', true)::uuid
        )
    );

CREATE POLICY landlord_sees_applicant_pillar_summaries ON pillar_summaries
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM applications a
            JOIN properties p ON p.id = a.property_id
            WHERE a.trust_profile_id = pillar_summaries.trust_profile_id
              AND p.landlord_id = current_setting('app.current_user_id', true)::uuid
        )
    );

CREATE POLICY renter_sees_own_evidence ON evidence_items
    FOR SELECT
    USING (renter_id = current_setting('app.current_user_id', true)::uuid);
-- Note: no landlord policy on evidence_items at all — landlords see
-- pillar_summaries (the derived confidence + which items contributed),
-- never the raw evidence documents themselves. That distinction is
-- deliberate: a payslip or reference letter is more sensitive than the
-- fact that it exists and was verified.

CREATE POLICY renter_inserts_own_evidence ON evidence_items
    FOR INSERT
    WITH CHECK (renter_id = current_setting('app.current_user_id', true)::uuid);

-- USING and WITH CHECK both given explicitly (functionally equivalent to
-- WITH-CHECK-only for UPDATE per Postgres's fallback rule, but explicit
-- here for clarity and so a renter can't reassign renter_id to someone
-- else's id via the same UPDATE). This ONLY enforces ownership — WHICH
-- status transition is allowed is enforced by the
-- evidence_items_enforce_status_transition trigger above, not this
-- policy; RLS policies can't express old-value-dependent rules.
--
-- Reviewer/admin verification (status -> 'verified'/'rejected') is
-- DELIBERATELY not covered by any policy yet — see the trigger's own
-- note above.
CREATE POLICY renter_updates_own_evidence ON evidence_items
    FOR UPDATE
    USING (renter_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (renter_id = current_setting('app.current_user_id', true)::uuid);

-- Financial verification status is visible to the renter only — no
-- landlord policy exists here at all, same as v1.
CREATE POLICY renter_sees_own_financial_verification ON financial_verifications
    FOR SELECT
    USING (renter_id = current_setting('app.current_user_id', true)::uuid);


-- ============================================================================
-- APPLICATION ROLE
-- ============================================================================
-- The `postgres` role (used for migrations/admin) has BYPASSRLS in local
-- Supabase by default — every RLS policy above is INERT for any
-- connection using it, silently. The application must connect as
-- app_user instead: plain LOGIN, no elevated attributes, not the owner of
-- any table it queries, so RLS applies to it normally with no extra
-- FORCE ROW LEVEL SECURITY needed.
--
-- Must run AFTER every CREATE TABLE above — GRANT ... ON ALL TABLES IN
-- SCHEMA public is a snapshot of whatever tables exist at the moment it
-- runs, not a standing rule; ALTER DEFAULT PRIVILEGES below is what
-- covers tables added by later migrations, but only for tables created
-- AFTER that statement runs, not retroactively.
--
-- Password intentionally omitted here — this file is a structural
-- reference, not a credential store. See the app_user migration for the
-- actual (well-known, local-dev-only) value; a real environment's
-- app_user password must never be the same one used locally.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user
            LOGIN
            PASSWORD '<set per-environment, see migration>'
            NOSUPERUSER
            NOBYPASSRLS
            NOCREATEDB
            NOCREATEROLE
            NOREPLICATION;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_user;

-- audit_log is append-only by design (see its own table comment above) —
-- the app may only INSERT, never UPDATE or DELETE existing rows. Explicit
-- REVOKE of both, even though DELETE was never granted above, so intent
-- is unambiguous and survives any future blanket GRANT.
REVOKE UPDATE, DELETE ON audit_log FROM app_user;

-- Keeps the grant applying to tables added by later migrations too, so
-- this doesn't silently drift as the schema grows.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE ON TABLES TO app_user;

-- trust_engine_service — a dedicated, narrowly-scoped, non-BYPASSRLS role
-- for trust_profiles/pillar_summaries writes — is DELIBERATELY not
-- created yet. There is no trust-assessment module to write through it;
-- building the role now would mean guessing at grants for code that
-- doesn't exist. (Rejected alternatives: reusing app_user with a
-- session-flag policy is spoofable by any other code running as the same
-- role over the same pool; Supabase's service_role bypasses RLS on every
-- table, not just these two. See the migration history for the full
-- reasoning.)