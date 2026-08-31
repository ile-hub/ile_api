-- Bootstrapped from db/schema.sql, the hand-revised source-of-truth draft
-- (see db/schema.sql header + CLAUDE.md). Supabase migrations are
-- forward-only, applied in filename order via `supabase db reset` /
-- `supabase migration up` -- when db/schema.sql changes, add a NEW
-- timestamped migration file for the delta, never edit this one after it
-- has been applied anywhere.

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
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

CREATE TABLE landlord_profiles (
    user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name        text NOT NULL,
    company_name        text,
    verification_status text NOT NULL DEFAULT 'unverified',
    created_at          timestamptz NOT NULL DEFAULT now()
);


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

-- Financial verification status is visible to the renter only — no
-- landlord policy exists here at all, same as v1.
CREATE POLICY renter_sees_own_financial_verification ON financial_verifications
    FOR SELECT
    USING (renter_id = current_setting('app.current_user_id', true)::uuid);