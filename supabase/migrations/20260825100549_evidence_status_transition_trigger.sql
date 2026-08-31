-- DB-level backstop for evidence_items status transitions, on top of the
-- service-layer guard in EvidenceService.withdrawEvidence. RLS's UPDATE
-- policy (renter_updates_own_evidence) only enforces ownership -- it
-- can't express "old status was X and new status is Y" in one predicate,
-- since USING sees only the pre-update row and WITH CHECK only the
-- post-update row. A trigger is the only mechanism with access to both.
--
-- Only ONE transition is legal today: submitted -> withdrawn. Nothing
-- else is permitted, including into 'verified'/'rejected' -- there is no
-- reviewer role or evidence-review module yet (see the previous
-- migration's note), so no code path should be able to set those values
-- regardless of which role or connection performs the write. When that
-- module gets designed, this function is where its legal transitions
-- get added, in a new migration -- not guessed at here.
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
