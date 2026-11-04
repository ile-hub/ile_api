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

CREATE TYPE property_status AS ENUM ('draft', 'published', 'archived');

CREATE TABLE properties (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    landlord_id         uuid NOT NULL REFERENCES landlord_profiles(user_id),
    title               text,                 -- optional listing copy
    description         text,
    address_line1        text NOT NULL,
    city                text NOT NULL,
    postcode            text NOT NULL,
    location             geography(Point, 4326),
    bedrooms            int NOT NULL CONSTRAINT properties_bedrooms_range CHECK (bedrooms BETWEEN 0 AND 20),
    rent_amount          numeric(10,2) NOT NULL CONSTRAINT properties_rent_positive CHECK (rent_amount > 0),
    currency            text NOT NULL DEFAULT 'GBP',
    property_rules       text[] NOT NULL DEFAULT '{}'
                         CONSTRAINT properties_rules_known
                         CHECK (property_rules <@ ARRAY['no_smoking', 'no_pets', 'sharers_ok']::text[]),
    status              property_status NOT NULL DEFAULT 'draft',
    published_at         timestamptz,          -- stamped by the status trigger, never client-supplied
    archived_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Columns match what ile-app's AddEditPropertyScreen collects. Not added
-- (no screen collects them): property_type, available_from. Tenancy
-- length lives on landlord_preferences (a matching preference, not a
-- listing attribute); "pets allowed" is the 'no_pets' rule, not a second
-- boolean. property_rules holds slugs, not display labels.

-- Status lifecycle: draft -> published, draft|published -> archived.
-- Nothing leaves archived, nothing returns to draft. Only reachable via
-- the API's named publish/archive actions; this trigger makes it hold
-- for every connection, and stamps published_at/archived_at.
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

-- RLS: landlord has full CRUD on their own rows; a renter can SELECT
-- published rows only (drafts/archived are invisible, not just filtered
-- by the API). Other landlords see nothing of each other's listings.
-- New rows must start as drafts.
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

CREATE POLICY landlord_sees_own_properties ON properties
    FOR SELECT
    USING (landlord_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY landlord_inserts_own_property ON properties
    FOR INSERT
    WITH CHECK (
        landlord_id = current_setting('app.current_user_id', true)::uuid
        AND status = 'draft'
    );

CREATE POLICY landlord_updates_own_property ON properties
    FOR UPDATE
    USING (landlord_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (landlord_id = current_setting('app.current_user_id', true)::uuid);

-- No DELETE route exists (archive is the user-facing action); FKs still
-- block deleting a property anything refers to.
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
-- MUTUAL MATCHING — NEW, human-driven, distinct from `matches` above
-- ----------------------------------------------------------------------------
-- `matches` (above) is the system-computed compatibility score, entirely
-- unaffected by this. tenancy_interests instead tracks whether a renter
-- and a landlord have EACH independently expressed real interest in the
-- same pairing — two humans acting, not an algorithm scoring.

CREATE TYPE tenancy_interest_status AS ENUM ('pending', 'matched', 'declined', 'withdrawn');

CREATE TABLE tenancy_interests (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    renter_id               uuid NOT NULL REFERENCES renter_profiles(user_id),
    property_id             uuid NOT NULL REFERENCES properties(id),
    renter_interested_at    timestamptz,          -- null until the renter acts
    landlord_interested_at  timestamptz,          -- null until the landlord acts
    status                  tenancy_interest_status NOT NULL DEFAULT 'pending',
    declined_by             text CHECK (declined_by IN ('renter', 'landlord')),
    matched_at               timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (renter_id, property_id)               -- one row per pair, ever
);
-- 'withdrawn' exists in the enum but is unreached by any endpoint today
-- — only two actions exist (express interest, decline), matching
-- evidence_status' 'verified'/'rejected' being unreachable until a
-- reviewer module exists: flagged, not built speculatively.

-- Auto-match trigger, enforced at the DB level rather than application
-- code — same reasoning as evidence_items_enforce_status_transition. A
-- BEFORE UPDATE trigger so it can mutate NEW in place before the row is
-- written. Guarding on NEW.status = 'pending' matters: without it, a
-- party touching an already-DECLINED row's timestamp could silently
-- flip a declined pairing back to 'matched' just because both
-- timestamps end up non-null — this only ever promotes pending ->
-- matched, never overrides a decline.
CREATE OR REPLACE FUNCTION tenancy_interests_auto_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status = 'pending'
       AND NEW.renter_interested_at IS NOT NULL
       AND NEW.landlord_interested_at IS NOT NULL THEN
        NEW.status := 'matched';
        NEW.matched_at := now();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tenancy_interests_auto_match_trigger
    BEFORE UPDATE ON tenancy_interests
    FOR EACH ROW
    EXECUTE FUNCTION tenancy_interests_auto_match();

-- RLS: each row is jointly "owned" by two different parties (the
-- renter, and whichever landlord owns property_id) — unlike every other
-- policy in this file so far, which scopes to exactly one party. Either
-- side may read and write their own pairing, with one exception: a
-- DECLINED row is visible (and updatable) only to the side that declined
-- it, so a decline is silent to the other party at the database level.
-- No DELETE policy — rows are never deleted, decline only ever sets
-- status.
ALTER TABLE tenancy_interests ENABLE ROW LEVEL SECURITY;

CREATE POLICY renter_or_landlord_sees_tenancy_interest ON tenancy_interests
    FOR SELECT
    USING (
        (
            renter_id = current_setting('app.current_user_id', true)::uuid
            AND (status <> 'declined' OR declined_by = 'renter')
        )
        OR (
            EXISTS (
                SELECT 1 FROM properties p
                WHERE p.id = tenancy_interests.property_id
                  AND p.landlord_id = current_setting('app.current_user_id', true)::uuid
            )
            AND (status <> 'declined' OR declined_by = 'landlord')
        )
    );

-- Covers both creation paths: a renter creating their own first row, and
-- a landlord creating a row for a specific applicant on a property they
-- own (landlord-initiated interest, before the renter has ever acted).
CREATE POLICY renter_or_landlord_inserts_tenancy_interest ON tenancy_interests
    FOR INSERT
    WITH CHECK (
        renter_id = current_setting('app.current_user_id', true)::uuid
        OR EXISTS (
            SELECT 1 FROM properties p
            WHERE p.id = property_id
              AND p.landlord_id = current_setting('app.current_user_id', true)::uuid
        )
    );

CREATE POLICY renter_or_landlord_updates_tenancy_interest ON tenancy_interests
    FOR UPDATE
    USING (
        (
            renter_id = current_setting('app.current_user_id', true)::uuid
            AND (status <> 'declined' OR declined_by = 'renter')
        )
        OR (
            EXISTS (
                SELECT 1 FROM properties p
                WHERE p.id = tenancy_interests.property_id
                  AND p.landlord_id = current_setting('app.current_user_id', true)::uuid
            )
            AND (status <> 'declined' OR declined_by = 'landlord')
        )
    )
    WITH CHECK (
        renter_id = current_setting('app.current_user_id', true)::uuid
        OR EXISTS (
            SELECT 1 FROM properties p
            WHERE p.id = tenancy_interests.property_id
              AND p.landlord_id = current_setting('app.current_user_id', true)::uuid
        )
    );

-- Who may write what. RLS decides whether a caller may touch a row; it
-- can't decide WHICH columns each side may change, or which status
-- transitions are legal, because a policy only sees one version of the
-- row. This trigger sees OLD, NEW and the caller (app.current_user_id):
--   - id, renter_id, property_id, created_at are immutable;
--   - each side sets only its own interest timestamp, once (NULL ->
--     value), and only while the property is published;
--   - pending -> matched only with both timestamps set (i.e. via
--     auto-match), pending|matched -> declined only with declined_by =
--     the caller's side; nothing leaves declined/withdrawn;
--   - INSERT starts pending with only the inserting side's timestamp.
-- It must fire AFTER tenancy_interests_auto_match_trigger (same-event
-- BEFORE triggers fire in name order: "..._auto_match_trigger" <
-- "..._enforce_write_rules"). Roles other than app_user with no
-- app.current_user_id (migrations, seeds) are let through; app_user
-- without it fails closed.
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
        SELECT p.status INTO prop_status FROM properties p WHERE p.id = NEW.property_id;
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

CREATE TRIGGER tenancy_interests_enforce_write_rules
    BEFORE INSERT OR UPDATE ON tenancy_interests
    FOR EACH ROW
    EXECUTE FUNCTION tenancy_interests_enforce_write_rules();

-- A landlord needs the display name of renters who expressed interest,
-- but renter_profiles' landlord policy only covers `applications`, and
-- widening it would expose the whole row (date_of_birth, bio, ...). This
-- SECURITY DEFINER function returns that one column, only to the
-- landlord on a row they're allowed to see.
CREATE OR REPLACE FUNCTION tenancy_interest_renter_display_name(p_interest_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT rp.display_name
    FROM tenancy_interests ti
    JOIN properties p ON p.id = ti.property_id
    JOIN renter_profiles rp ON rp.user_id = ti.renter_id
    WHERE ti.id = p_interest_id
      AND p.landlord_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      AND (ti.status <> 'declined' OR ti.declined_by = 'landlord');
$$;

REVOKE ALL ON FUNCTION tenancy_interest_renter_display_name(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy_interest_renter_display_name(uuid) TO app_user;

-- Renter-facing landlord profile (GET /landlords/:id). Same narrow pattern:
-- public fields only (id, display name, member-since), returned only to a
-- renter, and only for a landlord with at least one published property —
-- otherwise empty, so it never confirms a landlord exists. The landlord's
-- property list is read separately under properties' renter RLS.
CREATE OR REPLACE FUNCTION landlord_public_profile(p_landlord_id uuid)
RETURNS TABLE (id uuid, display_name text, member_since timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT lp.user_id, lp.display_name, lp.created_at
    FROM landlord_profiles lp
    WHERE lp.user_id = p_landlord_id
      AND EXISTS (
          SELECT 1 FROM users u
          WHERE u.id = nullif(current_setting('app.current_user_id', true), '')::uuid
            AND u.role = 'renter'
      )
      AND EXISTS (
          SELECT 1 FROM properties p
          WHERE p.landlord_id = lp.user_id
            AND p.status = 'published'
      );
$$;

REVOKE ALL ON FUNCTION landlord_public_profile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION landlord_public_profile(uuid) TO app_user;

-- landlord_profiles RLS: a landlord reads only their own row; cross-user
-- reads go through the narrow functions above/below, never the table.
-- No write policies: rows are created by handle_new_user() (SECURITY
-- DEFINER) and nothing edits them yet.
ALTER TABLE landlord_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY landlord_sees_own_profile ON landlord_profiles
    FOR SELECT
    USING (user_id = current_setting('app.current_user_id', true)::uuid);

-- The landlord's display name, for the RENTER on a tenancy_interests row.
-- Mirror of tenancy_interest_renter_display_name: one column, only to the
-- renter on that row, and only while the row is visible to them (same
-- declined-visibility rule as the tenancy_interests SELECT policy).
CREATE OR REPLACE FUNCTION tenancy_interest_landlord_display_name(p_interest_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT lp.display_name
    FROM tenancy_interests ti
    JOIN properties p ON p.id = ti.property_id
    JOIN landlord_profiles lp ON lp.user_id = p.landlord_id
    WHERE ti.id = p_interest_id
      AND ti.renter_id = nullif(current_setting('app.current_user_id', true), '')::uuid
      AND (ti.status <> 'declined' OR ti.declined_by = 'renter');
$$;

REVOKE ALL ON FUNCTION tenancy_interest_landlord_display_name(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenancy_interest_landlord_display_name(uuid) TO app_user;


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

-- DELETE on properties only, so landlord_deletes_own_property is reachable.
GRANT DELETE ON properties TO app_user;

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

-- PHASE 1 ADDITIVE FOUNDATIONS (14 October 2026)
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

-- Proposed editable ARCS catalogue. No pathway is mandatory or a ranking input.
CREATE TABLE leri_evidence_catalogue (
  id text PRIMARY KEY,
  pillar trust_pillar NOT NULL,
  label text NOT NULL CHECK (btrim(label) <> ''),
  display_order integer NOT NULL CHECK (display_order > 0),
  active boolean NOT NULL DEFAULT true
);
ALTER TABLE leri_evidence_catalogue ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_active_evidence_catalogue ON leri_evidence_catalogue FOR SELECT USING (active);
REVOKE ALL ON leri_evidence_catalogue FROM PUBLIC, anon, authenticated, app_user;
GRANT SELECT ON leri_evidence_catalogue TO app_user;
INSERT INTO leri_evidence_catalogue (id, pillar, label, display_order) VALUES
('affordability.payslips', 'affordability', 'Recent payslips (salaried work)', 1),
('affordability.employment_contract', 'affordability', 'Employment contract', 2),
('affordability.employer_income_letter', 'affordability', 'Employer letter confirming role/income', 3),
('affordability.regular_income_statements', 'affordability', 'Bank statements showing regular income (3 months)', 4),
('affordability.savings', 'affordability', 'Savings balance or savings evidence', 5),
('affordability.self_employed_invoices', 'affordability', 'Self-employed invoices or contracts', 6),
('affordability.self_employed_accounts', 'affordability', 'Self-employed accounts or accountant letter', 7),
('affordability.gig_earnings', 'affordability', 'Freelance/gig-work earnings history', 8),
('affordability.phd_finance', 'affordability', 'PhD finance confirmation', 9),
('affordability.scholarship_stipend', 'affordability', 'Scholarship, bursary, stipend or grant letter', 10),
('affordability.training_income', 'affordability', 'Apprenticeship or training income', 11),
('affordability.pension', 'affordability', 'Pension income evidence', 12),
('affordability.financial_support', 'affordability', 'Regular financial support or sponsorship letter', 13),
('affordability.combined_income', 'affordability', 'Multiple income sources combined', 14),
('affordability.advance_rent', 'affordability', 'Evidence of rent paid in advance, where appropriate', 15),
('affordability.other', 'affordability', 'Other credible affordability evidence + explanation', 16),
('reliability.landlord_reference', 'reliability', 'Previous private landlord reference', 1),
('reliability.agent_reference', 'reliability', 'Letting agent reference', 2),
('reliability.accommodation_reference', 'reliability', 'University accommodation or PBSA reference', 3),
('reliability.housing_provider_reference', 'reliability', 'Mid-market or social housing provider reference', 4),
('reliability.rent_history', 'reliability', 'Rent payment history or ledger', 5),
('reliability.redacted_rent_transactions', 'reliability', 'Bank transaction extracts showing rent paid (redacted)', 6),
('reliability.previous_tenancy', 'reliability', 'Previous tenancy agreement / tenancy dates', 7),
('reliability.tenancy_completion', 'reliability', 'Deposit return or tenancy completion confirmation', 8),
('reliability.professional_reference', 'reliability', 'Employer or professional reference', 9),
('reliability.character_reference', 'reliability', 'Character reference (with relationship disclosed)', 10),
('reliability.responsible_issue_resolution', 'reliability', 'Evidence of resolving tenancy issues responsibly', 11),
('reliability.first_time_renter', 'reliability', 'First-time renter: alternative references + personal explanation', 12),
('reliability.other', 'reliability', 'Other credible reliability evidence + explanation', 13),
('community.student_association', 'community', 'Membership of a university, college or student association', 1),
('community.professional_body', 'community', 'Membership of a professional body or industry association', 2),
('community.volunteering', 'community', 'Membership of a volunteering organisation or charity', 3),
('community.community_groups', 'community', 'Participation in community groups, clubs or local initiatives', 4),
('community.sports_society', 'community', 'Membership of a sports club, society or recreational organisation', 5),
('community.business_network', 'community', 'Involvement in professional, entrepreneurial or business networks', 6),
('community.recognised_network', 'community', 'Membership of a recognised organisation, association or other community network', 7),
('community.mentorship_support', 'community', 'Participation in mentorship, youth development or support programmes', 8),
('community.leader_reference', 'community', 'Reference or confirmation of involvement from an organisation or community leader', 9),
('community.reference_connections', 'community', 'Personal or professional connections willing to provide a reference', 10),
('community.guarantor', 'community', 'A guarantor willing to support the tenancy, where applicable', 11),
('community.institutional_guarantor', 'community', 'An institutional guarantor or recognised guarantor scheme, where available', 12),
('community.other_support', 'community', 'Other relevant community connections or support arrangements', 13),
('community.personal_explanation', 'community', 'Optional personal explanation of the renter''s community ties and support network', 14),
('stability.tenancy_timing', 'stability', 'Desired tenancy length / expected move-in date', 1),
('stability.study_duration', 'stability', 'Study enrolment or course-duration confirmation', 2),
('stability.employment_duration', 'stability', 'Employment confirmation or contract duration', 3),
('stability.relocation', 'stability', 'Planned relocation details', 4),
('stability.tenancy_history', 'stability', 'Previous tenancy length/history', 5),
('stability.ongoing_income', 'stability', 'Evidence of ongoing or expected income arrangements', 6),
('stability.guarantor', 'stability', 'Guarantor availability (optional, not universally required)', 7),
('stability.alternative_support', 'stability', 'Alternative support arrangement explanation', 8),
('stability.household_plans', 'stability', 'Household plans relevant to occupancy', 9),
('stability.first_time_new_arrival', 'stability', 'First-time renter or new arrival: explanation of circumstances', 10),
('stability.other', 'stability', 'Other stability evidence + explanation', 11);


-- PHASE 2: evidence, landlord preferences, safe properties and private Storage
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

-- People discovery increment (forward migration 20261014200000).
-- Additive, public projections only. No records/status history are rewritten.
CREATE FUNCTION leri_discovery(p_after uuid DEFAULT NULL, p_limit integer DEFAULT 21)
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT leri_public_profile(u.id) FROM users u
  JOIN users caller ON caller.id=nullif(current_setting('app.current_user_id',true),'')::uuid
  LEFT JOIN renter_profiles rp ON rp.user_id=u.id
  LEFT JOIN landlord_profiles lp ON lp.user_id=u.id
  WHERE caller.role IN ('renter','landlord') AND u.role IN ('renter','landlord') AND caller.role<>u.role
    AND CASE WHEN u.role='renter' THEN rp.discoverable ELSE lp.discoverable END
    AND (p_after IS NULL OR u.id>p_after)
  ORDER BY u.id LIMIT greatest(1,least(p_limit,51));
$$;
REVOKE ALL ON FUNCTION leri_discovery(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION leri_discovery(uuid,integer) TO app_user;

-- Demo connection increment: 20261014210000_person_connections.sql
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

-- Demo connection increment: 20261014211000_message_permissions.sql
-- Historical default privileges grant UPDATE on every new table to app_user.
-- Message RLS already denies updates; remove the unused privilege as well.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON leri_messages FROM app_user;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON leri_connections FROM app_user;
