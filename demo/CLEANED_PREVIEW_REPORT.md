Cleaned showcase demo-preview verification — 28 October 2026

The previously approved implementation and isolated SQL projections were already installed. This pass reused them, adapted verification to the cleaned dataset, and replaced the default-off API process on port 3001 with the existing guarded preview launcher. No duplicate feature, SQL installation, migration or new data was introduced.

Environment: leri-phase2-validation-20261014-final; workdir /private/tmp/leri-supabase-phase2-20261014-final; Supabase 127.0.0.1:55321; database 127.0.0.1:55322/postgres; restricted app_user. Existing Docker/port/project inspection passed. The live preview API is left running at http://localhost:3001, PID 71336, with GET /health returning 200 and {"status":"ok","db":"ok"}. Original development and production were not accessed.

Actual startup command

```sh
PORT=3001 LERI_SUPABASE_TEST_WORKDIR=/private/tmp/leri-supabase-phase2-20261014-final node scripts/run-isolated-demo-preview.mjs
```

This launcher sets preview configuration only for its child process: LERI_DEMO_PREVIEW=true, LERI_DEMO_PREVIEW_ALLOWLIST pointing to the reviewed demo/preview-allowlist.json, and the server-only local Storage signer setting. It uses the exact isolated environment; NODE_ENV defaults to development only when unset, HOST is loopback. No .env or persistent production setting changed. Ordinary launch remains default-off.

Actual live HTTP discovery results

| Account | Explore All | Suggested | Recommended people |
|---|---:|---:|---|
| Amina | 3 | 3 | Jamie, Lewis, Priya |
| David | 3 | 1 | Jamie |
| Sarah | 3 | 2 | Jamie, Lewis |
| Jamie | 3 | 3 | Amina, Sarah, David |
| Priya | 3 | 1 | Amina |
| Lewis | 3 | 2 | Amina, Sarah |

All six real password logins succeeded and their actual API identities matched the original IDs. Each Explore response contains exactly three opposite-role people. Suggested uses unchanged practical matching and existing reasons: preferred area and rent fits the stated budget. ARCS behavior, numeric ranking and matching source were not changed. Existing null structured date/tenancy values still produce no timing/term reason.

Seven preview homes and their existing photos were fetched as Jamie from the actual port-3001 API: Amina 3, David 3, Sarah 1. All seven signed photo downloads returned HTTP 200 and photo metadata illustrative=true. No upload, image replacement or new photo was performed.

Contract (unchanged from the already-approved preview contract)

Existing landlord public profiles, self-preview, discovery items and landlord connection-counterparty profiles contain safe nested properties. Existing /landlords/:landlordId/properties and nested detail/photo-download routes expose the same allowlisted homes to authorized demo viewers. A renter GET /properties/:id supports the safe preview fallback; the generic property listing feed remains published-only. No new HTTP routes or client-request feature flag were added.

Preview property responses preserve status=draft and publishedAt=null, and include:

```json
{"listingStatus":"demo_preview","presentation":{"mode":"synthetic_demo_preview","label":"Illustrative synthetic home — unpublished; compliance not checked","photosIllustrative":true}}
```

Preview photo metadata contains illustrative=true. Photos are retrieved through the existing download URL response {url, expiresIn:60}. These URLs are short-lived bearer capabilities. Public details omit street addresses, full private postcode, privateReference, registrationNumbers, registrationDetails, hmoLicenceDetails, storage object paths, filenames and evidence payloads. No registration/EPC/HMO verification claim is inferred from the images.

Safeguards reverified

The feature is disabled by default. Enabling requires development/test mode, exact loopback database and Supabase ports, E2E_ISOLATED_LOCAL=1, the exact unlinked workdir/project and a compiled-hash-matched allowlist. Startup compares that file with the installed SQL manifest and validates all six namespace-marked demo accounts and the seven property-owner draft bindings. Each request revalidates and uses a transaction-local preview GUC. The projection admits only those account/property IDs; landlords cannot preview another landlord’s draft through it. Production/staging/missing configuration, a changed/missing allowlist and invalid installed bindings fail closed. The normal public SQL functions and raw draft RLS remain closed.

The cleaned environment contains no outside draft or user to test as a live fixture. Without creating prohibited new fixtures, the tests therefore assert that the complete draft-ID set equals exactly the seven approved IDs, reject a nonallowlisted/unknown property UUID through the real API, reject a nonallowlisted caller UUID through actual SQL, deny direct authenticated RPC, and check anonymous/wrong-owner/default-off access. This does not claim an eighth real draft was created or tested.

Data preservation and tests

All seven database properties remain draft/unpublished; published_at is null. Six profiles, seven property IDs, seven active photo IDs, nine connections and six messages were preserved. Whole-row before/after counts and hashes match for users, renter/landlord profiles, properties, evidence, connections, messages and photos. Thus exact addresses, compliance fields, verification statuses and existing conversations were not changed. No signup, fixture insert, upload, record deletion, reseed or schema change occurred. Real Auth login sessions are expected, but existing passwords and IDs were reused.

- Build: passed.
- Unit tests: 83 passed across 5 suites, including default/production configuration guards and existing matching tests.
- Real-Supabase integration: 6 passed using only the six retained accounts and seven existing images; no data fixtures created.
- TypeScript noEmit: passed.
- Scoped ESLint with zero warnings: passed.
- Whitespace check: passed.
- Live localhost:3001 check: six logins, six identity/discovery checks, exact seven owner-mapped public property previews, seven renter-facing image downloads and health all passed.

Files changed in this pass

- test/demo-preview.e2e-spec.ts: removed assumptions about extra users/drafts and removed temporary photo upload/deletion. Added exact cleaned-count assertions and retrieval checks for all seven already-uploaded images.
- demo/CLEANED_PREVIEW_REPORT.md: this report.

No runtime source files, schema, migrations, matching algorithm or frontend files required changes in this pass. Existing reused implementation consists of src/common/demo-preview.service.ts, its global registration/request-transaction integration, profile/property/connection safe projection integration, demo/preview-allowlist.json, demo/isolated-preview.sql and scripts/run-isolated-demo-preview.mjs, as documented in PREVIEW_REPORT.md. No SQL was reapplied or migration-history entry added. Runtime process configuration changed only by starting the explicit approved launcher.

Gitignored evidence: demo/preview-verification.local and demo/live-cleaned-preview-verification.local. Existing credentials remain in demo/showcase.credentials.local; no secrets were printed or committed.

Remaining limitations: frontend rendering/labels were not changed or assessed in this backend task; clients must render the existing demo presentation label and permit explicitly labelled preview drafts. The six portrait HTTPS-hosting task remains separate. There is no backend property-preview blocker. The existing pg connection-list query-queue deprecation warning is non-failing and was not expanded into unrelated work.

Stopped after backend verification; the guarded API is left running on port 3001.
