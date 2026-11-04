# Lérí MVP implementation checklist

Audit date: 14 October 2026. Demo: 29 October 2026.
Source: all eight pages of `/Users/martins/Downloads/Leri app des.pdf`.
This specification supersedes conflicting product assumptions in `endpoint.md` and historical schema comments. Document content is treated as product requirements, not authority to deploy, run commands, or change production.

Status: **Exists** = implemented in source, not a claim of deployed verification; **Partial** = usable foundation with gaps; **Missing** = no implementation found; **Conflict** = current behavior contradicts the specification. Frontend behavior is outside this backend audit.

## Core model and journeys (PDF §§1–3, 5, 8)

| Requirement | Status | Evidence / work needed |
|---|---|---|
| Renter and landlord registration/login | Exists | Supabase Auth; atomic `handle_new_user()` trigger creates role-specific profiles. Self-assignment of admin roles rejected. |
| View privacy information, accept terms, separate optional consents | Missing | Versioned notice/terms delivery and acceptance/consent records. Frontend must present them. |
| Identity verification for both roles | Partial | Renter-only `identity_verifications` table, no routes/provider integration; landlord has a status field only. Add honest pending/demo states; never let real users self-verify. |
| Renter basic details and editing | Partial | Display name/bio stored; `GET /me` reads only. Add edit API, photo and verification provenance, current/preferred location, budget, move date, duration, household size/preferences. Budget/location/duration have schema-only foundations in `renter_preferences`. |
| Optional editable renter story | Missing | Add “Beyond the paperwork, why would you make a great tenant?” answer. |
| Flexible ARCS evidence submission | Partial | `/evidence` supports separate records with pillar/pathway/payload, list/get/withdraw; no configured options, explanation contract, uploads, edit/delete or safe summary. |
| Preview landlord-visible renter profile | Missing | One shared safe projection for preview, profile, discovery and incoming requests; exclude documents, financial values/account numbers and private payloads. |
| Landlord type and Scottish registration numbers/details | Missing | Individual/company/agent details; multiple registrations and pending check state. Number submission alone must not imply identity or registration verification. |
| Editable landlord profile | Partial | Display name/company/status exist; no edit endpoint. Add photo, experience, property count, covered locations, bio, communication style and letting approach. |
| Landlord personal prompts | Missing | Main tenant-expectations answer; optional tenancy-success answer. |
| Full profiles in both directions | Partial | `GET /landlords/:id` returns name/member-since/properties only, requires a published property. No landlord-facing renter profile endpoint. Add complete safe profiles and explicit discovery eligibility without inventing a mandatory property gate. |
| Person-to-person Request to Connect, either role initiates | Conflict | `/tenancy-interests` requires a property and has no note. Add independent sender/recipient requests with personalised note; optional property mention never binds the connection to a property. |
| Review shared information before sending | Missing | Safe profile preview and documented sharing contract; request must never attach private evidence automatically. |
| Incoming/outgoing/accepted lists | Partial | Existing interests are property pairings, not person requests. Add connection lists with direction and status. |
| Recipient accepts/declines/reviews later | Conflict | Current trigger auto-matches when two interest timestamps exist; no explicit recipient acceptance. Review Later can leave a request pending. |
| Sender sees Pending/Accepted/Declined | Conflict | Current RLS hides declines from the sender. New request statuses must remain visible to both participants. |
| Connected success state and clarification | Missing | API supplies accepted status/conversation; frontend shows “You’re Connected!” and clarifies no viewing/property/approval/reservation/tenancy guarantee. |
| Simple chat unlocked only after acceptance | Missing | No conversations/messages tables or routes. `endpoint.md` explicitly defers chat, which conflicts with this MVP. |
| Navigation and visual design | Frontend | Renter Discover/Connections/Profile; landlord adds Properties. Cream/green/sage/yellow, airy cards and small doodles. No swipe/heart interface or numerical tenant-quality labels. Backend must support these flows. |

## ARCS catalogue and behavior (PDF §4)

All **54** proposed choices below are **Missing as configurable catalogue entries**. Current `pathwayType` accepts any nonempty string without checking pillar membership. Seed stable IDs and editable labels/order/active flags; retain historical evidence when an option is retired. None is universally mandatory.

| Strand | Required selectable options |
|---|---|
| Affordability (16) | Recent payslips; employment contract; employer role/income letter; three months of regular-income bank statements; savings evidence; self-employed invoices/contracts; self-employed accounts/accountant letter; freelance/gig earnings; PhD finance confirmation; scholarship/bursary/stipend/grant; apprenticeship/training income; pension; regular financial support/sponsorship; combined income sources; rent paid in advance where appropriate; other credible evidence + explanation. |
| Reliability (13) | Private landlord reference; letting agent reference; university/PBSA reference; mid-market/social housing reference; rent history/ledger; redacted rent transactions; previous agreement/tenancy dates; deposit return/completion; employer/professional reference; character reference with relationship disclosed; responsible resolution of tenancy issues; first-time renter alternative references + explanation; other credible evidence + explanation. |
| Community (14) | University/college/student association; professional body/industry association; volunteering/charity; community groups/clubs/local initiatives; sports/society/recreation; professional/entrepreneurial/business networks; recognised organisation/association/community network; mentorship/youth/support programmes; organisation/community-leader confirmation; personal/professional reference connections; optional guarantor; institutional guarantor/scheme; other community/support arrangements; optional explanation of community ties/support. |
| Stability (11) | Desired length/move-in date; study/course duration; employment/contract duration; relocation plans; previous tenancy history/length; ongoing/expected income arrangements; optional guarantor availability; alternative support explanation; occupancy-related household plans; first-time renter/new-arrival circumstances; other stability evidence + explanation. |

- [ ] Select several pathways per strand; permit skipped pathways and optional files, with a short explanation field.
- [ ] Owner can edit evidence and attach/remove files; current withdrawal is not upload deletion.
- [ ] Public status uses “Information added”, “Document uploaded”, “Not provided”; current `submitted/verified/rejected/withdrawn` are internal lifecycle values.
- [ ] Public summaries contain categories/status only, never raw payload, document links or account numbers.
- [ ] Developer/admin can maintain catalogue without redesigning the app; do not expose unrestricted catalogue writes.
- [ ] ARCS never produces numerical trust/risk/suitability grades or filters/ranks discovery. Historical `trust_profiles`, confidence summaries and numeric `matches` are schema foundations, not the required MVP engine. Preserve records and exclude these assessments from the new public flows.

## Landlord preferences (PDF §5)

| Requirement | Status | Work needed |
|---|---|---|
| Rank all four ARCS strands 1–4; reorder | Missing | Validate a complete permutation with no duplicates. |
| Accept / Prefer / Not needed for each catalogue choice | Missing | Configurable evidence preferences, linked to catalogue. |
| Saved landlord defaults | Partial | `landlord_preferences` has nullable property ID, duration/household/rules only; no API or ARCS controls. |
| Property inherits defaults or customises | Missing | Explicit mode, effective preferences, owner-scoped writes. |
| Factual property constraints kept separate | Partial | Rent and three rules exist; occupancy, availability and duration missing from property API. |
| Evidence preferences cannot exclude/deprioritise renters | Missing | Enforce separation from recommendation inputs and test it. |
| Fair criteria; no protected-characteristic/proxy screening | Missing | Allowlist practical inputs; review supported criteria before live user testing. |

## Property fields and visibility (PDF §6)

| Field / behavior | Status | Existing implementation / gap |
|---|---|---|
| Private nickname/reference | Missing | Current optional `title` is listing copy, not a separate private reference. |
| Full address private by default | Conflict | `GET /properties`, detail, landlord profile and enriched interests expose address; separate owner and public response projections. |
| Public area/postcode district | Partial | City and full postcode exist; add deliberate safe area/district fields. |
| Monthly rent / deposit / bills | Partial | Rent/currency exist; deposit and bills missing. |
| Availability date / minimum and expected length | Partial | No listing fields/API; schema-only preference duration is insufficient. |
| Flat/house/room/studio/other | Missing | Add validated property type. |
| Bedrooms / bathrooms / permitted occupants | Partial | Bedrooms only. |
| Furnished/part-furnished/unfurnished | Missing | Add furnishing type. |
| Multiple photos and video/live walkthrough | Missing | Add media storage/metadata, ordering, ownership checks. |
| Description / key features | Partial | Description exists; structured features absent. |
| Council tax band / EPC | Missing | Add fields. |
| HMO status/details where required | Missing | Add fields and conditional validation. |
| Scottish registration details | Missing | Add owner-controlled property registration association/details. |
| Heating / energy / parking / outdoor / accessibility | Missing | Add factual feature fields. |
| Pets / smoking / lawful conditions | Partial | Only `no_pets`, `no_smoking`, `sharers_ok` supported. |
| Draft / available / unavailable | Conflict | Current enum is draft/published/archived; archive is terminal. Introduce explicit supported semantics without deleting or recasting historical records blindly. |
| Default or custom ARCS priorities | Missing | Add effective property preferences. |
| Multiple owner-managed properties | Exists | Create/list/edit/publish/archive with owner checks and RLS; two properties with complete details/photos still need a demo fixture. |
| Properties only inside landlord profiles | Conflict | Standalone renter feed exists. Retire its renter discovery use and supply landlord-nested public detail endpoints. Preserve owner management. |
| View-only property screens; connection from person profile | Conflict | Current tenancy-interest creation is property-scoped. New connections must target users; frontend provides Back to landlord profile. |

## Discovery (PDF §7)

| Requirement | Status | Work needed |
|---|---|---|
| Suggested for You for both roles | Missing | No recommendation service/endpoints; `matches` table alone is not an engine. |
| Explore All for both roles | Missing | Opposite-role profile browsing independent of recommendation eligibility, pagination; practical filters/search if feasible. |
| Practical compatibility | Partial | Some budget/location/duration schema fields exist, no API/calculation. Use location, budget/rent, availability/move date, duration, household/occupancy and lawful requirements. |
| Plain-English recommendation reasons | Missing | Return factual reasons; omit opaque percentages and risk/character claims. |
| Safe profile cards | Partial | Name only in limited landlord endpoint. Add supplied photo/logo, honest status, location, intro/highlights and available-property count. |
| Single inclusive discovery pool | Missing | No new Wildcard/high-risk/secondary group; no ARCS-based exclusion, grade or priority. Test alternatives and missing evidence leave recommendations unchanged. |
| Browse outside recommendations | Missing | Explore must remain available regardless of suggested results. |

## Verification, privacy and user control (PDF §9)

| Requirement | Status | Work needed |
|---|---|---|
| Honest real vs mock verification | Partial | Unverified defaults exist; no provider routes or clearly marked synthetic demo identities/photo status. Add server-controlled provenance. |
| Scottish Register check | Missing | Investigate reliable supported checking separately; do not assume an API. Keep pending absent an actual successful check. |
| Privacy notice / terms | Missing | Versioned content covering categories, purpose, lawful basis, sharing, retention, rights/contact; actual operator text needs review. |
| Separate optional consents | Missing | Store independently from terms acceptance; support changes. |
| Minimum data and private uploads | Partial | Evidence RLS restricts reads to owner, but arbitrary payload accepts sensitive content and no storage pipeline exists. Add scoped private storage, ownership and file validation, short-lived owner access, safe demo files. |
| Edit/delete uploads | Missing | Metadata and object removal with consistent failure handling. |
| Request account deletion | Missing | Add authenticated request workflow; preserve records until an authorised deletion process handles dependencies/retention. |
| Report/block | Missing | Add report intake and blocking; block checks affect profiles/discovery/requests/message access. |
| Secure access controls | Partial | JWKS guard, transaction-local user context, role checks, profile/evidence/property RLS and transition triggers exist. Users/preferences/identity and several other tables lack RLS in migrations; review grants and add least-privilege controls for new surfaces. Runtime pool does not itself reject BYPASSRLS credentials. |
| DPIA/fairness review before real sensitive-data testing | Outstanding review | Record review decision before collecting real financial/identity evidence or using profiling; not a code-only deliverable. |
| Synthetic demo only | Missing | Repeatable fictional renter/landlord profiles and dummy files, clearly identified; no real IDs, statements or references. |

## Minimum demo acceptance checklist (PDF §10)

- [ ] Both roles sign up **and edit** profiles (signup exists; editing missing).
- [ ] Renter story and several selectable ARCS pathways (missing).
- [ ] Private dummy file attach/remove (missing).
- [ ] Landlord ARCS ranking and accepted/preferred choices (missing).
- [ ] At least two fully detailed properties with photos (basic CRUD exists; completeness/fixtures missing).
- [ ] Properties inside landlord profiles with no separate renter feed (partial/conflicting).
- [ ] Both discovery modes for both roles (missing).
- [ ] Both roles open profiles and send personalised requests (partial profiles; requests missing).
- [ ] Recipient accepts/declines and sender sees status (missing/conflicting).
- [ ] Accepted request opens simple chat (missing).
- [ ] Honest verification/demo indicators, privacy notice and terms (partial/missing).

## Implementation phases

1. **Profiles, catalogue and privacy foundations.** Add forward-only migrations and update `db/schema.sql`; owner-editable profiles/preferences, honest demo verification, versioned notices/acceptances, all 54 catalogue options, safe profile projections and preview. Preserve existing working owner APIs and all records.
2. **Flexible evidence and complete properties.** Add explanations, validated catalogue selection, private dummy-file upload/edit/remove, safe ARCS summaries; complete property fields/media/defaults and custom ARCS controls. Separate private address/reference data from public output. Introduce available/unavailable semantics with backward-aware handling.
3. **People discovery.** Add opposite-role Explore and Suggested endpoints with transparent practical reasons, safe cards, nested landlord properties; remove standalone renter property discovery from the MVP contract. No trust/evidence ranking.
4. **Person connections and messaging.** New participant-based requests with notes, optional property mention, incoming/outgoing lists, recipient-only accept/decline, visible status for both, atomic conversation creation on acceptance and participant-only chat. Block/report checks and deletion-request workflow. Retain historical interests separately; never auto-convert old property matches into consented people connections.
5. **Demo integration and verification.** Complete synthetic seed data/dummy files, privacy/fairness review handoff, `API_CONTRACT.md` with implemented endpoints, examples, errors, auth, projections, transitions and frontend flow; run build, unit and isolated local E2E tests and report results.

Update the API contract as each phase lands; clearly distinguish implemented routes from planned ones. Existing `endpoint.md` is historical and includes now-conflicting choices (property feed, hidden declines, deferred chat, trust/confidence design).

No production deployment or production migrations without explicit approval. Do not run `db reset` or cleanup against existing user data. New migrations require a disposable/local validation target, not assumptions based on past comments saying tables were empty.

## Baseline validation

- `npm run build`: **passed** on 14 October 2026.
- `npm test -- --runInBand`: **exit 0, no tests found** (`--passWithNoTests`); not evidence of unit coverage.
- Existing E2E source covers `/me`, evidence ownership/withdrawal, property CRUD/RLS/transitions, landlord public profile and property-based interests. It does not cover the new specification flows.
- Database E2E suite **not run during this audit**: setup/teardown purges matching test users from configured databases, and local-only targeting must be established before execution. No database records were inspected or modified, and migration application state is unverified.
- Existing uncommitted edits and untracked landlord/migration/test files were included in the source audit and preserved. This phase adds this checklist only; no implementation changes or migrations were made.

## Phase 1 implementation update — 14 October 2026

Implemented owner profile retrieval/editing, optional renter story and landlord prompts, landlord registration submissions, server-controlled identity/photo/registration status foundations, safe opt-in public profiles and self-preview, versioned legal-document delivery, independent terms acceptance/privacy acknowledgement/optional consent history, and the configurable 54-option ARCS catalogue. Added two forward migrations and synchronized the schema draft. Existing public landlord profile cards no longer include full addresses.

Validation: backend build, full TypeScript check and targeted ESLint passed; 36 unit tests and 20 isolated HTTP/database integration tests passed. The isolated bootstrap omits PostGIS/geography only; session issuance is represented by a test guard. Existing Supabase E2E tests were not run because the local Docker/Supabase stack is unavailable. No existing/production database was accessed or migrated, and no existing records were deleted.

Remaining configuration: reviewed published terms/privacy content and actual verification providers. New legal routes return 503 until both documents are published; no verification route can fabricate successful checks. See `API_CONTRACT.md`, `LEGAL_CONTENT_SETUP.md` and `PHASE1_IMPLEMENTATION_REPORT.md`.

Phase 2 remains: editable multi-pathway evidence/explanations, private dummy-file attachment/removal, safe evidence-category summaries, complete property fields/gallery, landlord ARCS rankings/evidence preferences and default/custom property preferences. Existing standalone property/feed/interest address projections also require privacy hardening in Phase 2; they are not used by the new public profile endpoint.


## Real Supabase validation update — 14 October 2026

Docker/Supabase validation is now complete in a fresh isolated local stack: all 14 migrations applied with real PostGIS 3.3.7, 99 real-auth E2E tests and 36 unit tests passed, zero failures/skips. Existing synthetic records survived both Phase 1 migrations. The original populated local stack remains at four users/12 migrations and was inspected read-only. No remote/production database was changed. See `PHASE1_IMPLEMENTATION_REPORT.md` for environment, test and readiness details. Phase 2 remains pending explicit execution authorisation.

## Phase 2 implementation update — 14 October 2026

Implemented editable persistent catalogue selections/explanations, safe four-strand evidence summaries, private supporting-document upload/download/removal, landlord ARCS rank/choice defaults and property overrides, complete typed property details/media/availability, and private address/registration protection across modern and legacy public responses. Existing records/status history/owner CRUD are preserved; raw property rows are now owner-only. No tenant scoring or new property application flow was added.

Two additive migrations were validated only in fresh local Supabase stacks. Final checks: 122 real-auth Supabase E2E tests plus 62 unit tests passed, zero failures/skips; build, TypeScript and full source/test lint passed. Original development remains four users/12 migrations with no Phase 2 tables; production untouched. Runtime dependency advisories were resolved; 20 moderate development-tooling audit entries remain. See `PHASE2_IMPLEMENTATION_REPORT.md` and the updated `API_CONTRACT.md` for exact routes, tests, security and operational limitations.

Next implementation phase is people discovery, followed by person connection requests and messaging. Real legal/provider configuration and live-demo synthetic seeding remain separate work.


## Demo connection increments — 14 October 2026 (current backend status)

Implemented people-first opposite-role Explore/Suggested discovery through existing safe profiles; practical reasons with no ARCS/verification/risk scoring; independent person introductions; incoming/outgoing/accepted/declined/review-later states; recipient-only atomic acceptance; participant-only accepted messaging. Existing detailed properties/private gallery, flexible evidence/private supporting files/safe summaries and landlord ARCS/default/custom controls are reused, not duplicated. Historical interests remain unchanged and are never converted to consented requests.

- [x] Backend profile/story editing and public preview.
- [x] Backend flexible ARCS selection, private files and safe summaries.
- [x] Backend landlord preferences and complete property/media/nested public detail APIs.
- [x] Both discovery modes and both-role public profiles.
- [x] Personalised requests, explicit decisions and accepted-only messages.
- [x] Real-auth, privacy, RLS, concurrency and compatibility regression coverage.
- [ ] Frontend integration and actual UI demo validation (separate task).
- [ ] Blocking/reporting/account-deletion workflow, resend/withdraw requests and optional real-time/read receipts (not implemented).
- [ ] Reviewed real legal/provider setup and operational abuse/rate-limit/fairness review before real-user deployment. Synthetic demo remains the supported validation scope.

Three additive migrations applied to the confirmed populated isolated stack only. Existing users, legal documents, properties/evidence and historical interests preserved; tests add uniquely named synthetic fixtures and legal versions. Existing test cleanup remains disabled. Original development/production were not accessed or changed. Exact operations, transitions, pagination and limitations: API_CONTRACT.md.

Final demo increment verification: TypeScript, strict lint, Nest build, 65 unit tests and 142 real Supabase integration/E2E tests passed with zero failures/skips. Complete private-evidence/photo/discovery/request/accept/chat journey tested. All 19 migrations and original sentinels verified; live existing API endpoints return 200. Frontend integration/manual screen validation remains a separate pending task.
