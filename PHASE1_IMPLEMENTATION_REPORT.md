# Phase 1 implementation report

Implemented 14 October 2026 from the approved checklist and eight-page specification. No production migrations or deployments. No existing tables/records deleted. Existing uncommitted work retained.

## Files

Created:

- `src/profiles/profile.dto.ts`, `profile.types.ts`, `profiles.controller.ts`, `profiles.service.ts`, `profiles.module.ts`, `profiles.spec.ts` — models, validation, session-scoped updates, safe public profile/preview and unit tests.
- `src/privacy/privacy.dto.ts`, `privacy.controller.ts`, `privacy.service.ts`, `privacy.module.ts`, `privacy.spec.ts` — versioned documents, terms acceptance, notice acknowledgements, separate optional consent events and unit tests.
- `supabase/migrations/20261014130000_profile_privacy_foundations.sql` — profile fields, verification provenance, owner writes/RLS, explicit safe SQL projections, immutable legal versions and append-only privacy records.
- `supabase/migrations/20261014131000_arcs_catalogue.sql` — editable 54-option catalogue, read-only application access.
- `test/phase1.integration-spec.ts`, `test/jest-phase1.json` — isolated database/HTTP integration runner, without existing destructive cleanup hooks.
- `API_CONTRACT.md`, `LEGAL_CONTENT_SETUP.md`, `PHASE1_IMPLEMENTATION_REPORT.md`.

Modified:

- `src/app.module.ts` — registers new modules alongside all existing modules.
- `src/evidence/evidence.controller.ts`, `src/evidence/evidence.service.ts` — authenticated catalogue read route; existing submission API retained.
- `src/landlords/landlords.controller.ts`, `src/landlords/landlords.service.ts` — removes full address from public profile cards and defines the safe response type. These files already existed as untracked user work; they were extended, not replaced.
- `test/landlords.e2e-spec.ts` — adjusts expected public response to exclude address, preserving the rest of the existing test.
- `db/schema.sql` — appends the exact additive migrations, preserving existing edits.
- `package.json` — adds `test:phase1` script; no new dependencies.
- `IMPLEMENTATION_CHECKLIST.md` — appends Phase 1 results without replacing the original audit.

Other pre-existing modified/untracked files were left intact, including `.env.example`, `endpoint.md`, `package-lock.json`, existing `/me` and tenancy-interest work, earlier landlord migrations and test cleanup files.

## Endpoints

| Method | Path | Behavior |
|---|---|---|
| GET | `/me/profile` | Own renter/landlord profile |
| PATCH | `/me/profile` | Role-specific owner edits, atomic profile/preferences update |
| GET | `/me/profile/preview` | Exact safe public projection of own profile |
| GET | `/profiles/:id` | Opt-in, opposite-role safe profile; no private documents, current renter location or registration details |
| GET | `/legal/documents` | Public latest published terms/privacy notice, or 503 when unconfigured |
| GET | `/me/privacy` | Own acceptances/acknowledgements and latest optional consent choices |
| POST | `/me/privacy/terms-acceptance` | Idempotent acceptance of current terms version |
| POST | `/me/privacy/notice-acknowledgement` | Independent acknowledgement of current privacy notice |
| PUT | `/me/privacy/consents` | Append optional grant/withdrawal events; default is false |
| GET | `/evidence/catalogue` | All active configurable evidence options |

All except legal-document retrieval require the existing Supabase session. Existing `GET /landlords/:id` now omits `addressLine1` from property cards; this intentional privacy change requires a frontend/shared-type adjustment. Other working APIs are preserved.

## Supabase validation — 14 October 2026

Docker Desktop is running (Docker Engine 29.7.2); Supabase CLI 2.115.0 is installed. The original `ile-api` stack was already healthy and was not restarted, reset or migrated. PostgreSQL, Auth, Storage, Kong, Realtime, Studio, metadata, mail testing and analytics services in the isolated stack are running. REST and Auth/JWKS requests and a service-authorised Storage bucket request return 200. Storage functionality was also exercised with successful synthetic upload and denied unauthorised downloads/signing.

### Targets and isolation

| Target | API / PostgreSQL | Result |
|---|---|---|
| Existing local development `ile-api` | `127.0.0.1:54321` / `127.0.0.1:54322/postgres` | Read-only inspection only; four users and 12 migrations before and after; Phase 1 legal tables still absent |
| Initial disposable validation project | `leri-phase1-validation-20261014` | First full test run and affected-suite rerun; subsequently stopped with data backup retained |
| Final fresh disposable validation project | `leri-phase1-validation-20261014-final`; API `127.0.0.1:55321`, PostgreSQL `127.0.0.1:55322/postgres`, Studio `127.0.0.1:56323` | Healthy and retained with synthetic validation data |
| Production / remote Supabase | Not targeted | No remote database commands, deployments, linking or infrastructure changes |

Isolated configuration is copied from the existing project into `/private/tmp/leri-supabase-phase1-20261014-final`; the project ID and ports differ. The source configuration and `.env` are unchanged. No linked-project reference exists in either the source or isolated directory. No seed file exists in the source despite its configured `seed.sql` path; isolated seed paths are empty. Only explicit local `start`, `status`, `migration up --local`, and disposable-stack `stop` operations were used. The populated development stack was never the target of a migration or test.

The first isolated start hit a Studio port conflict at 55323. Moving only the disposable Studio port to 56323 resolved it. This was an environment issue, not a schema failure.

### Migration results

Both Phase 1 migrations applied successfully to fresh, isolated Supabase databases:

- `20261014130000_profile_privacy_foundations.sql`
- `20261014131000_arcs_catalogue.sql`

All 14 migrations, including all 12 historical migrations, are recorded in the final stack. PostgreSQL 17 and PostGIS **3.3.7** are present; no extension, geography column or migration was omitted. Synthetic renter/landlord accounts were created through real Supabase Auth before Phase 1 was applied, with existing renter biography, evidence and property rows. Their stored values were compared before/after migration and again after tests; they remain unchanged.

The catalogue has all **54 active options**: affordability 16, reliability 13, community 14, stability 11. Profile fields/prompts, private/public projections, verification metadata/constraints, legal version history, terms/privacy acknowledgement records, optional consent history, RLS policies and column privileges passed validation.

### Test results

| Check | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Final full real-Supabase E2E run, 6 suites | **99** | **0** | **0** |
| Unit tests, 2 suites | **36** | **0** | **0** |
| Total final current validation | **135** | **0** | **0** |

Backend build, full TypeScript check, targeted ESLint and whitespace checks also passed. The earlier 20 standalone PostgreSQL integration tests are retained but are not included in this run's totals; they are superseded for this validation by the real-Supabase tests.

The first full run passed 94 of 95 tests. One older landlord test expected a verification-status update to return zero rows. Phase 1 deliberately revokes write permission on that column, so PostgreSQL correctly returned `42501`. The assertion now requires that stricter denial and separately checks that another landlord cannot update an editable profile column. No permissions or implementation protections were loosened. The affected suite then passed 7/7; the final full fresh-stack run passed all 99 tests, including additional privacy/versioning/constraint checks.

Authentication uses real Supabase account creation, password sessions and the unchanged production `JwtAuthGuard`/JWKS verification. Invalid and signature-tampered tokens are rejected. There is **no substituted authentication guard** in these E2E tests. Tests assert that the application database role is `app_user`, without superuser or BYPASSRLS privileges.

RLS/authorization checks cover owner edits, cross-user profile/preferences/privacy access, wrong-role fields, opt-out visibility, protected verification/demo fields, immutable privacy history, backdating prevention and wrong-document-kind acknowledgements. New profile projections omit private data; sensitive base tables do not expose rows through the authenticated Supabase Data API. Private Storage objects cannot be downloaded publicly or by other users/anonymous clients, and those clients cannot mint signed URLs. Storage assertions require an access-denial status, not a server error. Phase 1 does not implement owner upload/download APIs; those remain Phase 2.

### Validation code and repeatability

Added:

- `test/phase1.e2e-spec.ts` — 27 real-auth Phase 1/Supabase/Storage tests.
- `test/isolated-target.ts` — fail-closed loopback target/port/database-role checks.
- `scripts/isolated-supabase-env.mjs` — reads local CLI status privately; refuses linked/nonmatching projects; never reads `.env` or prints keys.
- `scripts/prepare-isolated-phase1.mjs` — refuses populated/already-migrated preparation targets, creates synthetic preservation fixtures, applies the two local migrations and compares stored data.
- `scripts/run-isolated-supabase-e2e.mjs` — runs the entire existing E2E suite against explicit isolated targets with real authentication.
- `scripts/inspect-isolated-supabase.mjs` — read-only service/schema/catalogue/RLS/preservation checks.

Extended `test/helpers.ts`, `test/e2e-cleanup.ts` and test-mode configuration in `src/app.module.ts` so isolated runs ignore `.env` and disable deletion cleanup. Existing cleanup code is preserved for legacy invocations; use the isolated command below rather than the original `.env`-targeted runner. Extended `test/landlords.e2e-spec.ts` with the stronger permission/RLS assertions. Added `test:e2e:isolated` to `package.json`. Existing unrelated uncommitted work remains intact.

Command for the isolated runner:

```sh
LERI_SUPABASE_TEST_WORKDIR=/private/tmp/leri-supabase-phase1-20261014-final npm run test:e2e:isolated
```

The full Phase 1 suite expects a fresh legal-document fixture corpus. For another complete clean validation, create a new disposable stack/directory and run preparation before testing; do not reset or delete the retained validation database. Individual unaffected legacy suites can be rerun with `-- --runTestsByPath test/<suite>.e2e-spec.ts`. Synthetic test records and private dummy files are retained; original database records are not cleaned up.

## Configuration and remaining work

Migrations are applied and tested only in disposable local Supabase stacks, not in the existing development or production database. Application deployment must include the migrations on an explicitly authorised target; use the existing non-superuser, non-BYPASSRLS `app_user` database role.

Reviewed legal content is not configured. Both terms and privacy notice must be published by the operator; see `LEGAL_CONTENT_SETUP.md`. Until then, document retrieval/acceptance writes return 503. Own privacy state can still be read. No policy text is invented or silently published.

No actual identity/photo provider or Scottish Register checking integration is configured. Statuses remain honest; registration submission is pending, and users cannot set successful verification or demo flags. A successful status requires trusted verification-result metadata. Demo fixtures must use server-managed demo provenance and synthetic content.

For Phase 2: flexible evidence editing/explanations, private dummy-file uploads/removal and safe category/status summaries; complete property details/photos and public/private address separation; landlord ARCS ranking/evidence preferences and default/custom property preferences. Discovery, person requests, explicit recipient acceptance and chat remain later phases. Legacy property-based interests are not converted into people connections.

## Frontend integration readiness

**Phase 1 code and API contract are ready for frontend integration against an authorised schema with both migrations applied.** The isolated local stack provides that validated schema. The original development database still has only the 12 historical migrations, so new profile/privacy routes must not be pointed at it until an explicitly approved migration step is arranged. Backend processes must use matching isolated Auth keys/URLs and the non-BYPASSRLS `app_user` connection; the test runner sources those values privately from local CLI status.

The isolated stack contains synthetic demo legal content used by tests, not reviewed operator policy. Real operator terms/privacy content and real verification integrations remain configuration/review blockers for real-user use, not blockers for frontend development with synthetic data and honest unverified/demo states. Legacy standalone property/address projections still require the Phase 2 privacy work described in the API contract.

No new implementation migration or production fix was needed during this validation. No unresolved Phase 1 test failure remains. Phase 2 was not started: the explicit implementation execution scope to date was Phase 1; this turn validates that phase and records readiness.


## Subsequent Phase 2 update

Phase 2 has since been authorised, implemented and validated. See `PHASE2_IMPLEMENTATION_REPORT.md` for the current 16-migration isolated schema, 122 real-Supabase E2E tests, 62 unit tests and updated privacy/media/preference contracts. Earlier Phase 1-only statements above are retained as historical validation results. The original populated development database remains unmigrated and production remains untouched.
