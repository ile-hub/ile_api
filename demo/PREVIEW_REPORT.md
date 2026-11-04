Isolated synthetic property preview — 28 October 2026

Implemented and verified only against leri-phase2-validation-20261014-final: Supabase http://127.0.0.1:55321, PostgreSQL 127.0.0.1:55322/postgres, workdir /private/tmp/leri-supabase-phase2-20261014-final. Dedicated Docker database/gateway IDs, project-specific retained volume, 19 existing migrations and restricted app_user were checked by the existing isolation inspector. Original dev and remote/production were not accessed. The old historical migration sentinel remains absent; historical sentinel preservation is not claimed.

Outcome

Seven allowlisted homes now appear as explicitly labelled synthetic previews under their actual landlords: Amina 3, David 3, Sarah 1. All seven database rows remain draft, published_at null; genuinely published count remains 0. Portfolio counts remain Amina 3 and David 5; no additional undescribed David homes were invented.

| Account | Explore All people | Suggested people | Suggested demo people |
|---|---:|---:|---|
| Amina | 49 | 3 | Jamie, Priya, Lewis |
| David | 49 | 1 | Jamie |
| Sarah | 49 | 2 | Jamie, Lewis |
| Jamie | 36 | 3 | Amina, David, Sarah |
| Priya | 36 | 1 | Amina |
| Lewis | 36 | 2 | Amina, Sarah |

These are actual paginated HTTP API results with preview enabled. Explore All’s ordered person IDs exactly equal the default-off response for each account; totals include retained historical synthetic profiles. Existing compatibilityReasons source/rules are unchanged. Reasons include “In your preferred area” (landlord version: “In the renter’s preferred area”) and “Rent fits the stated budget”. No evidence preference, missing rental history, identity status or numeric score determines eligibility. Timing/tenancy-duration reasons remain absent because structured renter date/duration fields are unset.

Safety and data preservation

- The feature defaults off. Explicit true requires NODE_ENV development or test, E2E_ISOLATED_LOCAL=1, the exact workdir and project configuration, no linked project, exact loopback Supabase and app_user database URLs, and the reviewed allowlist file’s compiled SHA-256. Missing/altered configuration fails closed. Production/staging/undefined NODE_ENV is rejected when enabling it.
- Startup compares the SQL manifest to that file and verifies all six namespace-labelled, discoverable demo accounts and all seven draft/available property-owner relationships. Each request rechecks configuration and database ownership/state before setting a transaction-local preview GUC. Invalid ownership/state disables the whole preview through failure, rather than partially admitting records.
- SQL functions permit only the six fixed callers. Renters may preview the three fixed landlords; landlords may preview their own homes. Other authenticated users get no preview rows even if they set the preview GUC in a database test. anon/authenticated roles cannot execute the new functions through Supabase RPC. The normal public SQL functions, raw-table RLS and Storage policies are unchanged.
- Only an explicit public-field allowlist is projected. Private street/postcode fields, registration numbers/details, HMO licence details, private references, filenames, storage object paths and evidence payloads are excluded. Owner-only CRUD endpoints keep their existing access rules.
- EPC remains null, HMO unknown, registration numbers empty and all identity/photo/registration checks unverified. The existing publish endpoint still returns 400 for the incomplete property. No verification event or compliance claim was generated.
- The isolated SQL installer was run twice. Before/after whole-row counts and hashes were identical for users, profiles/preferences, properties, evidence, connections, messages and photo metadata. Integration teardown independently verifies whole-row equality. The six accounts, seven property IDs, nine connections and six messages are unchanged. The installer creates/replaces four read-only projection/helper functions, not data.

Exact API contract

No new HTTP route or client request flag was added. Preview admission is a trusted server configuration, never a query/body/header parameter. With the gate disabled, existing responses and authorization remain unchanged.

When admitted, the existing safe property representation gains:

```json
{
  "id": "65ed0783-8f5e-464b-9300-033a80f4aba5",
  "landlordId": "33144328-594b-4c09-9eeb-2913c2c39b0f",
  "status": "draft",
  "listingStatus": "demo_preview",
  "publishedAt": null,
  "presentation": {
    "mode": "synthetic_demo_preview",
    "label": "Illustrative synthetic home — unpublished; compliance not checked",
    "photosIllustrative": true
  }
}
```

The full response also contains the existing public-safe id/landlordId/title/description/city/bedrooms/rentAmount/currency/propertyRules/archivedAt/createdAt/updatedAt/details/arcsPreferences/photos fields. details uses the same allowed public keys as the existing production projection, without substituting private-postcode fallback data. Each preview photo metadata entry contains id, mimeType, caption, position and illustrative=true. No numeric compatibility score was added.

Preview homes are nested in landlord profiles returned by:

- GET /profiles/:landlordId
- GET /me/profile and GET /me/profile/preview for the owner
- GET /discovery?mode=all or mode=suggested, within items[].profile.properties (people remain the discovery unit)
- Connection responses’ counterparty.properties where the counterparty is an eligible landlord

The same safe objects are available through GET /landlords/:landlordId/properties, GET /landlords/:landlordId/properties/:propertyId and GET /properties/:propertyId for an admitted renter. Wrong owner paths, nonallowlisted drafts and default-off draft detail reads return 404. Owner GET /properties/:id and /properties/me remain the existing owner CRUD representations. The generic GET /properties listing feed remains published-only; no new public pool of preview listings is created.

Photos

Owner POST /properties/:propertyId/photos, caption editing, validation, metadata stripping, storage bucket and owner upload policy are unchanged. Uploads must be captioned as illustrative; preview metadata additionally marks illustrative=true and the property presentation marks photosIllustrative=true.

GET /landlords/:landlordId/properties/:propertyId/photos/:photoId/download (or the existing renter property-photo route) first requires preview admission and a photo belonging to that exact approved property/owner with the expected immutable object path. It then reuses the existing Storage signing/download method to return `{url, expiresIn:60}`. For this preview-only branch, the guarded isolated launcher supplies the local Supabase service-role key in the dedicated LERI_DEMO_PREVIEW_STORAGE_KEY setting; this is a privileged credential, not a restricted signing-only key. It is used only after the exact preview/photo authorization and is never returned to clients. Normal downloads continue using the caller’s JWT. No Storage policy was widened; direct renter Storage access to the draft photo was tested and denied. A shared signed URL remains a bearer capability for up to 60 seconds, as with existing photo downloads.

No permanent illustrative photos were seeded in this backend task. A tiny generated test PNG was uploaded through the real owner API, captioned illustrative, downloaded by an admitted renter through a signed URL, and removed together with its test-only metadata. Before/after photo rows match exactly. Actual demo image assets can be added later through the unchanged upload API; no photo is claimed to show an actual home.

Minimal frontend contract (documentation only; no frontend changed)

Use the existing landlord/profile/property screens and nested properties arrays. Permit rendering `status=draft` only when the backend supplies listingStatus=demo_preview AND presentation.mode=synthetic_demo_preview. Display presentation.label prominently on cards and details; mark images illustrative and preserve unknown compliance values. Do not turn this response into a Published/Verified badge or a tenancy/application promise. Continue person-to-person connection actions. Existing clients that discard every draft object or ignore presentation labels need this small display adjustment; backend verification does not claim that UI work is done.

Configuration and operation

New configuration:

| Key | Default / required enabled value |
|---|---|
| LERI_DEMO_PREVIEW | absent/false means disabled; only explicit string true enables validation |
| LERI_DEMO_PREVIEW_ALLOWLIST | absent; enabled mode requires the reviewed demo/preview-allowlist.json file with its compiled hash |
| LERI_DEMO_PREVIEW_STORAGE_KEY | absent; server-only local Storage signer supplied by the guarded launcher, used only after preview/photo authorization |

Existing keys are enforced rather than relaxed: NODE_ENV development/test, E2E_ISOLATED_LOCAL=1, LERI_SUPABASE_TEST_WORKDIR exact path, DATABASE_URL app_user at 127.0.0.1:55322/postgres, SUPABASE_URL http://127.0.0.1:55321. The launcher defaults HOST=127.0.0.1 and PORT=3109; NODE_ENV defaults to development only if unset and never overrides production. REQUIRE_VERIFICATION and all normal publication checks remain unchanged. The existing isolated environment helper already sets REQUIRE_VERIFICATION=false; that is not a preview publication bypass.

Commands from repository root:

```sh
npm run build
LERI_SUPABASE_TEST_WORKDIR=/private/tmp/leri-supabase-phase2-20261014-final node scripts/install-isolated-demo-preview.mjs
LERI_SUPABASE_TEST_WORKDIR=/private/tmp/leri-supabase-phase2-20261014-final node scripts/run-isolated-demo-preview.mjs
```

No .env or persisted production configuration was changed. Ordinary npm start/start:isolated does not enable the feature. The new launcher verifies the isolated Docker target, sets the explicit preview configuration and removes general admin database/service/JWT secrets before starting the application; only the local service-role key in the dedicated preview-signing setting remains for this gated photo branch. Test applications were stopped after verification; no server is left running by the tests.

SQL / migration inventory

Applied only demo/isolated-preview.sql, outside the standard supabase/migrations directory. It adds four functions: leri_demo_preview_manifest(), leri_demo_preview_valid(), leri_demo_preview_properties(uuid), leri_demo_preview_photo_path(uuid,uuid), with restricted grants. The installation transaction refuses an incorrect account/property mapping. No table, enum, existing function, RLS policy or normal publication validator was changed. No migration-history entry was added; the existing 19 migration records are unchanged. This SQL is intentionally not a production deployment migration.

Changed-file inventory for this implementation (pre-existing uncommitted work preserved)

Added:
- src/common/demo-preview.service.ts — default-off environment/allowlist validation and scoped projection service.
- src/common/demo-preview.spec.ts — configuration and startup failure tests.
- test/demo-preview.e2e-spec.ts — real Auth/API/PostgreSQL/Storage coverage using existing accounts.
- demo/preview-allowlist.json — exact six accounts and seven property-owner bindings.
- demo/isolated-preview.sql — isolated read-only SQL helpers/projections.
- scripts/install-isolated-demo-preview.mjs — target verification, repeatable SQL installation and data snapshots.
- scripts/run-isolated-demo-preview.mjs — guarded local preview API launcher.
- demo/PREVIEW_REPORT.md — results, API and frontend contract.

Modified:
- src/common/common.module.ts — registers/exports the preview service.
- src/common/rls-transaction.interceptor.ts — sets preview admission only inside the authenticated request transaction.
- src/common/private-storage.service.ts — accepts an explicit internal signer token; default remains the request JWT.
- src/profiles/profiles.service.ts — augments approved landlord public representations before calling unchanged matching rules.
- src/properties/properties.service.ts — approved public-detail/list/photo fallback and response presentation type.
- src/connections/connections.service.ts — consistent safe landlord preview in counterparty profiles.
- src/profiles/profiles.spec.ts and src/common/phase2.spec.ts — constructor test mocks updated for the new dependency.

Verification artifacts (gitignored, no passwords or bearer tokens): demo/preview-install.local and demo/preview-verification.local. Existing credentials remain in demo/showcase.credentials.local, mode 0600; they were used for six successful real Supabase logins and were not changed.

Test results

- npm run build: passed.
- npm test -- --runInBand: 83 tests across 5 suites passed.
- npx tsc --noEmit --incremental false: passed.
- Scoped ESLint with --max-warnings=0: passed.
- Real-Supabase test/demo-preview.e2e-spec.ts: 6 tests passed, repeated successfully. Checks all seven exact IDs, landlord ownership, safe profile/list/detail payloads, unchanged Explore identities, actual Suggested reasons/counts, default-off/anonymous/wrong-owner/nonallowlisted access, direct RPC denial, outsider SQL denial, transaction-local gate, unchanged public SQL/raw RLS, draft status, unchanged publication refusal/verification, accepted/pending messaging and real upload/signed-download authorization.
- Installer rerun: passed with identical data snapshots; no duplicates.
- Integration before/after whole-row snapshots: identical, including existing profiles, properties, evidence, connections, messages and photos. The transient test photo was the only created fixture and was removed.

Limitations: preview remains deliberately tied to this exact dataset and local environment; invalidating any binding makes it fail closed. UI labels require the documented frontend adjustment. No permanent photo assets were added. Structured date/tenancy preferences remain unset. Existing connection-list parallel SQL produces a pg deprecation warning; it does not fail the tests and was not expanded into unrelated backend work. Normal publication remains blocked by its original completeness requirements, as intended.

Stopped after backend implementation and verification.
