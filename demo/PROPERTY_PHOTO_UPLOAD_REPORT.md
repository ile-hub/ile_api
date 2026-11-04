Illustrative property photo upload report — 28 October 2026

Completed only in leri-phase2-validation-20261014-final, Supabase 127.0.0.1:55321 and PostgreSQL 127.0.0.1:55322/postgres, through the existing API at http://localhost:3001. Docker container identities, retained project volume, exact ports and restricted API database role were reverified. The original dev stack and production were not accessed.

All seven existing property IDs and landlord owners were validated against the approved mapping, live read-only database rows, authenticated API /me identities and owner property-detail responses before the first upload. Asset hashes matched the inspected crop manifest.

| Landlord / property | Existing property ID | New photo ID | Active photos | Image retrieval |
|---|---|---|---:|---:|
| Amina / Shawlands flat | `cf2d559d-cecd-4009-a878-68d37a7453b1` | `1f97a8cc-4bf9-4321-a629-4ec2933af37b` | 1 | HTTP 200 |
| Amina / Merchant City Living | `8b630e59-06f8-4c34-adf6-cee09dec0924` | `a9eed07c-b182-41fc-bb1d-9a3897b60e2f` | 1 | HTTP 200 |
| Amina / Dennistoun Corner Flat | `65ed0783-8f5e-464b-9300-033a80f4aba5` | `613855e2-fdeb-4d8e-9198-b90f0a445f81` | 1 | HTTP 200 |
| David / Partick flat | `51a1b692-42c1-4cb9-be21-c552bdd6193c` | `bbf5f01d-d20d-4834-afe5-9c3982782488` | 1 | HTTP 200 |
| David / Shawlands Garden Flat | `61959473-5da7-48e5-a652-33ccb689f8c4` | `470003d9-f14f-4076-97f7-f9e0f1d9addf` | 1 | HTTP 200 |
| David / Finnieston Loft | `734630cc-320f-4b74-9c05-9fa74afd0921` | `9fdd6c9d-7502-45bb-b7f2-d7d48d9d0ee4` | 1 | HTTP 200 |
| Sarah / Dennistoun flat | `7b5520c0-1f72-4006-94de-333a8cfd9bd1` | `e0f70085-1062-4558-940c-eb66a9181009` | 1 | HTTP 200 |

API results

Seven owner-authenticated POST /properties/:id/photos requests used multipart field file and returned HTTP 201. Seven PATCH /properties/:id/photos/:photoId calls returned 200 and set position 0 and caption “Illustrative image for demo purposes — synthetic interior, not an actual home”. Every owner photo-list and download/signing endpoint returned 200. Actual signed-image GETs returned 200; decoded dimensions and pixel hashes matched the corresponding approved crop, rather than merely checking that a URL exists. No signed URLs, passwords or bearer tokens are included in the report.

Idempotence

Added scripts/upload-showcase-property-photos.mjs with an exclusive local lock, exact target/asset/owner preflight, durable mode-0600 checkpoint and filename/content recovery after interrupted uploads. Unexpected existing photos cause a refusal rather than deletion/replacement. A complete second run reused the same seven photo IDs, issued no upload or caption update requests, and verified one active photo per property again. No duplicates were created.

Preservation

All seven properties remain draft, with publishedAt null. Whole-row before/after checks across users, renter/landlord profiles, renter preferences, properties, evidence, connections and messages were unchanged in both runs. This includes all existing EPC, registration, HMO and verification fields. Account IDs, emails and encrypted password values, plus credential-file bytes, were unchanged. Normal Auth session/sign-in metadata changes from genuine owner logins are expected; no passwords/accounts were created or edited. Confirmed six approved accounts, seven property records, nine connections and six messages. Only seven new photo metadata rows and their seven Storage objects were added, with captions/positions set on those new photos.

No frontend, matching rule, database schema, storage policy, migration or publication-validator changes occurred. No publication endpoint or direct database mutation was used. Retrieval was verified through the owner-authenticated endpoints; the running API’s preview configuration was not changed, so this task does not claim additional renter-facing preview verification.

Files added: scripts/upload-showcase-property-photos.mjs and this report. Local gitignored mode-0600 checkpoints/evidence: demo/property-photo-uploads.local, demo/property-photo-upload-first-run.local, demo/property-photo-upload-verification.local. The crops remain under ignored demo/assets/properties/. Nothing was committed.

Repeat from repository root with the isolated stack and API running:

```sh
LERI_SUPABASE_TEST_WORKDIR=/private/tmp/leri-supabase-phase2-20261014-final node scripts/upload-showcase-property-photos.mjs
```

Errors: none in either run. Script syntax check and whitespace check passed. Stopped after verification.
