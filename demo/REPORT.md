Demo preparation report — 28 October 2026

Status: six demo people and the complete connection/chat sample are prepared. Property publication and compatibility suggestions remain blocked; showcase preparation is incomplete.

Environment: `leri-phase2-validation-20261014-final`, workdir `/private/tmp/leri-supabase-phase2-20261014-final`, Supabase `http://127.0.0.1:55321`, PostgreSQL `127.0.0.1:55322/postgres`. Docker confirms dedicated database/gateway container identities and project-specific retained database volume. The original `ile-api` stack uses 54321/54322 and was not queried or modified. All 19 expected migrations exist; API uses non-superuser, non-BYPASSRLS `app_user`. Original migration sentinel file is absent; historical preservation cannot be independently rechecked. Full isolation evidence is in gitignored `verification.local`.

Records created: six Auth users, six profiles, seven owner-only draft properties, seven evidence selections (two Jamie, three Priya, two Lewis), nine person connections and six messages. No legal documents or private evidence files created. Portfolio counts: Amina 3, David 5; three David homes described and drafted, two undescribed homes not invented.

| Person | Role | Account ID | Explore All | Suggested |
|---|---|---|---:|---:|
| Amina | landlord | `33144328-594b-4c09-9eeb-2913c2c39b0f` | 49 | 0 |
| David | landlord | `bbc84e2a-5e68-47d7-8ce2-69b218d3d550` | 49 | 0 |
| Sarah | landlord | `b47ba3cc-7aa1-439a-9df6-b1e68fc92457` | 49 | 0 |
| Jamie | renter | `5271e678-d8ee-4f23-81b7-29e1dd9b0b3c` | 36 | 0 |
| Priya | renter | `835b4e68-5ad7-4069-ad56-e15b6cf4a063` | 36 | 0 |
| Lewis | renter | `56fa85f3-eb9b-4203-a763-2a7863569f36` | 36 | 0 |

Explore totals include retained synthetic test history. Each person sees all three new opposite-role demo people. No existing discovery profiles were hidden or deleted. Suggested results are genuinely empty; no reasons or scores were fabricated. The existing rules match area, budget, availability, tenancy length and household fit without using ARCS exclusion.

Each user has one incoming pending, one outgoing pending and one accepted connection. Accepted pairs: Amina/Jamie, David/Priya, Sarah/Lewis. Each accepted thread contains one renter viewing question and one landlord reply. GET and POST on all pending threads return 409; accepted message reads return 200 from both participants. Repeat runs preserve all record IDs and message counts.

Properties: **0 published, 7 drafts**. Owner property lists/details return 200: Amina 3, David 3, Sarah 1. Exact street values are explicitly synthetic placeholders. Approved rent, deposit, availability, minimum term, bedrooms, bathrooms, occupancy, furnishing and council tax values are applied. Original descriptions/areas retained. EPC remains null, registrationNumbers empty, HMO status unknown. No registration numbers or legal-compliance claims generated. No portrait/property photos supplied or generated.

All seven POST `/properties/:id/publish` calls return HTTP 400 with:

```json
{
  "message": "Complete rental details and registration information are required before availability",
  "error": "Bad Request",
  "statusCode": 400
}
```

The database/DTO permits missing EPC and registration data in draft records. `PropertiesService.requireComplete` rejects missing postcodeDistrict, EPC and empty registrationNumbers before checking for at least one uploaded photo. EPC enum is A–G or exempt: no unknown option. HMO enum supports unknown and that value is used. No schema, validation, migration or API implementation changed. Registration numbers are owner-only; they are not exposed in public property projections.

Jamie GET `/profiles/33144328-594b-4c09-9eeb-2913c2c39b0f` returns 200 with Amina and `properties: []`. GET `/landlords/33144328-594b-4c09-9eeb-2913c2c39b0f/properties` returns 200 with `[]`. Jamie can discover Amina; he cannot view unpublished homes. No access rule was bypassed to display drafts.

All six public previews return verification.mode=demo and unverified identity/photo statuses; landlords also retain unverified registration status. Only is_demo was set on namespace-checked synthetic accounts. Separate simulated successful verification presentation is unsupported by the existing API; no successful verification records were written.

Working credentials: `demo/showcase.credentials.local` (mode 0600, ignored by git). All six password logins succeeded against local Supabase Auth. No passwords, tokens or service keys in this report. Raw API evidence: `demo/verification.local` (mode 0600, ignored).

Validation: build passed; 29 tests in discovery/profile suites passed; seed and isolation script syntax checks passed; git diff whitespace check passed. Real HTTP checks cover six logins, both discovery modes, opposite-role profile details, seven owner property records, nine connections and accepted/pending message permissions. Seed reruns retained account/property/connection IDs and six messages. Property publication remains blocked as above.

Run from repository root, with existing stack running:

```sh
npm run build
LERI_SUPABASE_TEST_WORKDIR=/private/tmp/leri-supabase-phase2-20261014-final node scripts/seed-showcase-demo.mjs
```

The script takes an exclusive local lock and starts a temporary API at 127.0.0.1:3109 using the isolated environment. It never loads credentials into reports, resets databases, applies migrations, deletes retained data, or connects to remote Supabase. It checkpoints synthetic records and updates only seed-owned draft properties when the approved payload changes. A crash may leave a lock file: check no seed process is running before removing that local lock.

Stopped after demo preparation and verification. Remaining release blocker: approved source data/media or a separately approved product change allowing unknown compliance details to publish.
