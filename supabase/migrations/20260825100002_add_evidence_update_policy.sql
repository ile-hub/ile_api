-- Renter-initiated UPDATEs on evidence_items -- previously there was no
-- UPDATE policy at all (default-deny), so even the owning renter could
-- not withdraw their own submitted evidence.
--
-- Includes an explicit USING alongside the requested WITH CHECK, not just
-- WITH CHECK alone: for UPDATE, USING governs which EXISTING rows a
-- renter may target at all; WITH CHECK governs what the row is allowed to
-- look like AFTER the update. (Per Postgres semantics, omitting USING on
-- an UPDATE policy falls back to reusing WITH CHECK for both, so this is
-- functionally equivalent to WITH-CHECK-only -- written explicitly here
-- to match every other policy in this schema, and so it's unambiguous
-- that this also stops a renter reassigning renter_id to someone else's
-- id via the same UPDATE.)
--
-- This policy only ever enforces OWNERSHIP (renter_id = session), not
-- WHICH status transition is being made -- Postgres RLS policies compare
-- either the pre-update row (USING) or the post-update row (WITH CHECK)
-- in isolation; neither can express "old status was X AND new status is
-- Y" in one predicate. That's why the submitted-to-withdrawn-only rule
-- lives in the application layer (EvidenceService.withdrawEvidence),
-- not here -- see that file, and the open decision on whether to also
-- enforce it with a trigger.
CREATE POLICY renter_updates_own_evidence ON evidence_items
    FOR UPDATE
    USING (renter_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (renter_id = current_setting('app.current_user_id', true)::uuid);

-- Reviewer/admin verification of evidence (status -> 'verified' /
-- 'rejected') is DELIBERATELY not covered by any policy yet. There is no
-- reviewer role or evidence-review module in db/schema.sql or the app --
-- adding a policy now would mean guessing at a role structure that
-- hasn't been decided, the same reasoning that deferred trust_engine_service
-- until the trust-assessment module exists. Flagged as a follow-up
-- decision, not built here.
