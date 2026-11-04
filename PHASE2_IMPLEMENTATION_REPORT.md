# Lérí Phase 2 implementation report

Completed 14 October 2026 from `Leri app des.pdf`, the approved checklist and existing NestJS/PostgreSQL architecture. The original populated development database and production were not modified. Existing uncommitted work is preserved.

## Implemented

- Existing evidence module now supports persistent catalogue selections, multiple pathways per strand, private editable explanations, selection changes within a strand, deselection and neutral four-strand public summaries. Old free-form pathways/payloads and withdrawal endpoints remain supported. No scores, risk labels or evidence-based ranking were added.
- Supporting files use a new private Supabase bucket, owner/session-scoped object keys, RLS, matching MIME/signature checks, a 5 MiB limit and ten active documents per item. Only owners receive metadata/download links. Removal deletes bytes and retains removed metadata/history. Public summaries contain categories/status only.
- Existing landlord service stores reorderable 1–4 ARCS priorities and Accept/Prefer/Not needed choices in `landlord_preferences`. Defaults, property overrides, effective settings and retained prior overrides are supported. Historical preference rows are unchanged. These choices do not filter/rank renters.
- Existing property module supports complete typed details: private reference/address/registration/HMO information; public area/district; rent/deposit/bills; availability/tenancy duration; type/rooms/occupancy/furnishing; features; council tax/EPC; heating/energy/parking/outdoor/accessibility; lawful pets/smoking conditions; video/live walkthrough URLs.
- Multiple photos use a private bucket with owner writes and controlled available-listing reads. Images are fully decoded/re-encoded, with a 20 megapixel/5 MiB limit, and EXIF/GPS/other metadata stripped. Gallery supports captions/order/removal and 60-second links. Removing a modern listing's final photo makes it unavailable. Archived-photo removal/download remains available to owners.
- New availability controls expose draft/available/unavailable semantics while retaining the original draft/published/archived status history and terminal archive. Historical/minimal CRUD remains compatible. Modern detailed listings require core rental/Scottish fields and a photo before publication/availability.
- Explicit SQL public projections protect private addresses, full postcodes, references and sensitive registration/HMO information across profile, nested property, legacy property/feed and renter tenancy-interest responses. Raw property rows are owner-only; the historical broad applicant-profile policy was removed. Historical records were not deleted. Owner management responses retain private fields.

The approved renter experience remains people-first: properties appear inside landlord profiles and are view-only. Legacy feed/interests remain compatibility routes with safe projections; no property application, reservation or property-scoped new connection mechanism was added.

## Migrations

1. `20261014140000_phase2_evidence_properties.sql` — additive evidence/property/preference fields, media metadata, validation/ownership constraints, indexes/RLS, safe projections and legacy-interest read compatibility.
2. `20261014141000_phase2_private_storage.sql` — private bounded buckets, Supabase `auth.uid()` access policies, immutable object keys and media identity/history constraints.

`db/schema.sql` contains both migrations exactly, appended without replacing earlier work. Existing table rows, enum values, legacy evidence payloads and landlord preference records remain intact. Only broad cross-user SELECT policies are replaced; no existing tables or data are dropped.

## API contract

[API_CONTRACT.md](API_CONTRACT.md) documents all 20 new routes, extended requests/responses, ownership/authentication, private/public fields, multipart limits, errors, compatibility and lifecycle behavior:

- Evidence: PATCH/DELETE selection, GET summary, document upload/list/download/removal.
- Landlords: GET/PUT default ARCS preferences.
- Properties: availability; GET/PUT effective/custom preferences; photo list/upload/edit/download/removal; landlord-nested available property list/detail/photo access.

The original property create/list/read/update/publish/archive routes remain. Renter responses intentionally no longer include `addressLine1` or full `postcode`; frontend/shared types must use the safe contract. Modern detail responses extend legacy owner responses. Profile types include safe summaries, preferences and nested available properties.

## Validation

| Final check | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Real Supabase E2E, 7 suites (99 existing + 23 Phase 2) | **122** | **0** | **0** |
| Unit tests, 3 suites | **62** | **0** | **0** |
| Total | **184** | **0** | **0** |

Backend build, full TypeScript check, read-only full ESLint over `src/**/*.ts` and `test/**/*.ts`, whitespace checks and schema/migration consistency all pass.

The first full E2E run passed 120/121 and found one implementation bug: class-transformer added undefined fields to partial detail objects, masking saved values during merge validation. PostgreSQL still rejected inconsistent data, but the API returned 500. The merge now discards undefined patch values before validating the saved/updated state; regression coverage verifies correct 400 responses and preservation of other fields. The affected 22-test suite passed after the fix. The final fresh-stack run also includes image metadata protection and final-photo behavior and passes all 122 tests. Tests were not weakened; old raw-property expectations now require owner-only access plus a separate successful safe projection, and renter interest expectations exclude the formerly exposed address/postcode.

### Real environment and preservation

- Docker/Supabase services are healthy, including real PostgreSQL 17, PostGIS 3.3.7, Auth/JWKS, REST and Storage. All **16 migrations** are recorded. All **54 catalogue options** remain active.
- Final disposable project: `leri-phase2-validation-20261014-final`, configuration `/private/tmp/leri-supabase-phase2-20261014-final`; API `127.0.0.1:55321`, database `127.0.0.1:55322/postgres`, Studio `127.0.0.1:56323`.
- Both validation stacks began fresh with 14 baseline migrations. Synthetic accounts were created through real Supabase Auth, with legacy evidence/property/preference fixtures before applying Phase 2. Their original values were checked before/after migration and retained after testing. No reset or deletion cleanup was used. Earlier disposable stacks were stopped with data retained; the final stack remains available with synthetic test history.
- The original `ile-api` stack remains on ports 54321/54322 with **four users and 12 migrations**. Read-only final inspection confirmed Phase 2 tables are absent. The original configuration and `.env` were not changed. No remote project was linked or targeted; no production infrastructure was changed.

E2E tests use actual Supabase password sessions and the unchanged production JWT/JWKS guard, not a substituted guard. The backend database role is non-superuser/non-BYPASSRLS `app_user`. Tests cover owner/cross-user access, real file upload/download/removal, spoofed/empty/oversized files, private bucket access and forged paths, safe summaries, explicit public field exclusion, raw-row RLS, preference inheritance/overrides, database constraints, complete listings, photos and availability/archive behavior. Unit tests additionally prove image metadata removal and remote-upload compensation on database commit failure.

Commands:

```sh
npm run build
npm test -- --runInBand
npx tsc --noEmit --incremental false
npx eslint 'src/**/*.ts' 'test/**/*.ts'
LERI_SUPABASE_TEST_WORKDIR=/private/tmp/leri-supabase-phase2-20261014-final npm run test:e2e:isolated
```

For another complete run, create another fresh isolated stack and use `scripts/prepare-isolated-phase2.mjs` before running tests; do not reset the populated validation/development databases. The full Phase 1 fixture suite requires a fresh legal-document corpus. Phase 2-only reruns can use `-- --runTestsByPath test/phase2.e2e-spec.ts` and create new synthetic users without deleting prior records.

## Security and remaining issues

- Production dependency audit (`npm audit --omit=dev`): **zero reported vulnerabilities** after compatible security updates, including the existing HTTP/Multer stack. Sharp 0.35.5 was added; platform-express is 11.2.7 and Multer 2.4.0. No forced major upgrade/downgrade was applied.
- Full dependency audit: **20 moderate entries remain in the Jest/Istanbul development-tooling chain**, rooted in the `sprintf-js` precision-specifier advisory. npm's remaining forced fix proposes a breaking ts-jest/Jest downgrade; it was not applied. There are no remaining high/critical audit entries. This tooling limitation is not concealed by the passing tests.
- Storage and PostgreSQL have separate transactions. Upload rollback/commit failure invokes compensation; a failed compensation is logged. Interrupted deletion can leave retained metadata pointing to an already-missing object; retry removal reconciles it. Private access policies remain in force throughout. No background cleanup/outbox worker was added.
- Existing signed gallery links may remain valid for their remaining 60 seconds after availability changes; newly requested links/raw renter reads are denied immediately. File removal deletes the actual object.
- Real operator legal text, verification providers/Scottish registration checks and the real-data privacy/fairness review remain configuration/review work. Tests publish only synthetic demo legal content and use dummy files. Registration submissions are not verification or compliance certification.
- Legacy minimal property payloads remain accepted to preserve working APIs; they are not backfilled with invented required details. The MVP frontend should use the full details/photo workflow.
- Discovery/recommendations, person-to-person connection requests, accepted-connection messaging, block/report/deletion-request workflows and polished live-demo seed data remain later phases. Phase 2 does not add these prematurely.

## File manifest

Created: `src/common/private-storage.service.ts`, `src/common/phase2.spec.ts`, `src/landlords/arcs-preferences.dto.ts`, `src/properties/dto/property-details.dto.ts`, both Phase 2 migrations, `test/phase2.e2e-spec.ts`, `scripts/prepare-isolated-phase2.mjs`, this report.

Extended existing evidence, landlords and properties controllers/services/modules and DTOs; common request context/transaction handling; safe profile types; tenancy-interest projection/controllers; schema draft; isolated environment helper; property/interest E2E expectations; `package.json`/lockfile; API contract and implementation checklist. Existing Phase 1 and unrelated uncommitted edits remain preserved. No duplicate evidence/property/preference service implementation was introduced.

Photo processing follows [Sharp's default metadata removal](https://sharp.pixelplumbing.com/api-output/) with a configured [input pixel limit](https://sharp.pixelplumbing.com/api-constructor/), verified by unit tests. Dependency advisory detail: [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).

## Demo connection increments completed — 14 October 2026

The initial Phase 2 evidence/property work above is retained. The next checklist capabilities (people discovery, person connections and messaging) are now implemented and validated. No property-interest records were converted or removed; no duplicate profile, evidence, property or preference service was created. A dedicated person-request table is necessary because legacy interests require a property and auto-match reciprocation. The accepted person connection itself is the conversation; there is no parallel conversation relationship.

Implemented:
- `/discovery` in the existing Profiles controller/service, safe opposite-role visible profiles, independent Explore and practical Suggested reasons. No ARCS/verification/risk ranking or numerical scores. Stable candidate pagination; missing inputs remain unknown and unmatched profiles can still be explored.
- One Connections module, existing auth/context/transaction infrastructure, immutable introductions, sender/recipient ownership, pending/review-later/accepted/declined states and recipient-only decisions. Unique unordered pair prevents reciprocal auto-acceptance or duplicate requests. Accepted state is atomic and final; recipient decision retries are idempotent.
- Accepted-only text messaging with participant RLS and sender checks. Per-thread advisory transaction locking orders HTTP sends and cursor commits so polling cannot skip an earlier concurrent send. No generic status update or message mutation route.
- Existing complete property/photo, private ARCS documents, safe summary and landlord preference APIs reused in a real complete journey test.

Validation (final code):
- `npx tsc --noEmit`: passed.
- `npx eslint "{src,test}/**/*.ts" --max-warnings=0`: passed.
- `npm run build`: passed.
- `npm test -- --runInBand`: 65 tests / 4 suites passed.
- `LERI_SUPABASE_TEST_WORKDIR=/private/tmp/leri-supabase-phase2-20261014-final npm run test:e2e:isolated`: 142 real Supabase HTTP/database/Storage tests / 9 suites passed, zero failures/skips.
- Included the complete synthetic renter story -> multiple ARCS selections/private PDF -> landlord priorities -> two fully detailed properties/private photo processing -> public nested detail/photo download -> Suggested -> personalised introduction -> acceptance -> real message retrieval journey.
- Privacy/authorization/RLS tests cover role/visibility, private profile/address/document exclusion, nonparticipant reads/writes, sender impersonation, recipient-only decisions, terminal states, review-later chat lock, reciprocal duplicates, competing decisions and concurrent messages. Existing Phase 1/2 regression suite remains green.
- Read-only isolated inspection: all 19 migrations present, original renter/evidence/property sentinels unchanged, all 54 catalogue entries present, Auth/JWKS/REST/Storage healthy.
- Live existing API port 3000: authenticated `/discovery?mode=all`, `/discovery?mode=suggested`, `/connections` and `/health` return 200 using the dedicated synthetic renter. No profile edits in this readiness check.
- `git diff --check`: passed.

Environment/data: only confirmed `leri-phase2-validation-20261014-final` (Auth 55321 / PostgreSQL 55322). Three additive migrations; user count unchanged by each migration. No reset, purge, linked-project command, production setting or remote deployment. Tests retain synthetic users/properties/messages/files and append uniquely versioned demo legal fixtures. Existing documents/acceptance history are preserved; the latest published synthetic legal version can change as a normal consequence of those tests. The old fixed `v1`/`v2` legal tests were updated to work safely on this populated target. The configured-document 200 state is now expected when documents already exist; unconfigured 503 behavior remains covered by existing unit tests rather than deleting publications to force it.

New files (11): `src/profiles/discovery.ts`, `src/profiles/discovery.spec.ts`; `src/connections/connections.controller.ts`, `connections.dto.ts`, `connections.module.ts`, `connections.service.ts`; `test/discovery.e2e-spec.ts`, `test/connections.e2e-spec.ts`; `supabase/migrations/20261014200000_people_discovery.sql`, `20261014210000_person_connections.sql`, `20261014211000_message_permissions.sql`.
Modified existing backend files (8): `src/app.module.ts`, `src/profiles/profiles.controller.ts`, `src/profiles/profiles.service.ts`, `test/phase1.e2e-spec.ts`, `db/schema.sql`, `API_CONTRACT.md`, `IMPLEMENTATION_CHECKLIST.md`, `PHASE2_IMPLEMENTATION_REPORT.md`. No files removed. Existing unrelated edits were preserved. The frontend's existing `API_CONTRACT.md` is synchronized as documentation only; no frontend implementation changed.

Remaining: frontend integration/manual UI persistence gate; optional polished reusable demo-account seeding; block/report/account-deletion workflows; withdrawal/resend after decline; WebSocket/push/read receipts/attachments; rate limiting/abuse controls and real operator/provider/legal/fairness configuration. Suggestions currently use exact normalized city/area/district comparisons, not geographic search. Evidence properties/media already follow the prior contract's documented constraints and storage compensation limitations. These are demo-tested local capabilities, not a production deployment or a claim of completed UI integration.
