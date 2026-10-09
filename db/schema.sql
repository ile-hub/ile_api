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