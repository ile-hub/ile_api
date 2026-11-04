Demo credentials and photo readiness audit — 28 October 2026

Environment: leri-phase2-validation-20261014-final only. Supabase http://127.0.0.1:55321; PostgreSQL 127.0.0.1:55322/postgres; running API http://localhost:3001 (PID 55816). The existing Docker/project/port inspector passed. API health returned HTTP 200 with {"status":"ok","db":"ok"}. No original dev or production access.

Login readiness

Passwords were read privately from demo/showcase.credentials.local and used only for the local Supabase password-grant request. Each resulting real session token was tested against the running API. No signup, password reset or account creation was used.

| Account | Role | Login email | Auth login | API /me | API /me/profile | Portrait |
|---|---|---|---:|---:|---:|---|
| Amina | landlord | leri-showcase-20261029-amina@example.test | 200 | 200 | 200 | Missing |
| David | landlord | leri-showcase-20261029-david@example.test | 200 | 200 | 200 | Missing |
| Sarah | landlord | leri-showcase-20261029-sarah@example.test | 200 | 200 | 200 | Missing |
| Jamie | renter | leri-showcase-20261029-jamie@example.test | 200 | 200 | 200 | Missing |
| Priya | renter | leri-showcase-20261029-priya@example.test | 200 | 200 | 200 | Missing |
| Lewis | renter | leri-showcase-20261029-lewis@example.test | 200 | 200 | 200 | Missing |

Each API identity and role matched the expected existing account. Credentials file is mode 0600, ignored by git and not tracked. Its bytes were unchanged by the audit. Password database values, account IDs and emails were compared privately before/after and were unchanged. No passwords, session tokens, refresh tokens or signing keys appear in this report or the audit JSON. Successful Auth logins naturally create sessions/update Auth sign-in metadata; no profile or password edit was performed.

Portrait audit

All six photoUrl fields are unset: Amina, David, Sarah, Jamie, Priya and Lewis have no usable portrait. There were no configured image URLs to fetch or decode. All identity/photo statuses remain unverified; landlords also retain unverified registration status, with verification.mode=demo.

Property photo audit

| Owner | Existing property | Property ID | Active photos | Owner photo-list API |
|---|---|---|---:|---:|
| David | Partick flat | `51a1b692-42c1-4cb9-be21-c552bdd6193c` | 0 | 200 |
| David | Shawlands Garden Flat | `61959473-5da7-48e5-a652-33ccb689f8c4` | 0 | 200 |
| Amina | Dennistoun Corner Flat | `65ed0783-8f5e-464b-9300-033a80f4aba5` | 0 | 200 |
| David | Finnieston Loft | `734630cc-320f-4b74-9c05-9fa74afd0921` | 0 | 200 |
| Sarah | Dennistoun flat | `7b5520c0-1f72-4006-94de-333a8cfd9bd1` | 0 | 200 |
| Amina | Merchant City Living | `8b630e59-06f8-4c34-adf6-cee09dec0924` | 0 | 200 |
| Amina | Shawlands flat | `cf2d559d-cecd-4009-a878-68d37a7453b1` | 0 | 200 |

All seven remain draft with publishedAt null. Active photo metadata counts were cross-checked against the actual owner GET /properties/:id/photos responses. There are zero Storage objects joined to active photo records for these seven homes. No images were uploaded or removed by this audit.

Supported methods and blockers

Portraits: PATCH /me/profile accepts {"photoUrl":"https://approved-public-host/fictional-portrait.jpg"} using that person’s authenticated session. The URL must be public HTTPS, include a valid hostname, contain no embedded username/password, and be <=2048 characters. There is no portrait multipart-upload endpoint or managed portrait bucket integration in this API. The field stores a URL; it does not establish identity/photo verification or guarantee that the URL serves a usable image. The local Supabase HTTP URL is not accepted as a portrait HTTPS URL. Private property/evidence bucket links are not a suitable durable public portrait source. An approved, simulator-reachable public HTTPS asset host is needed; no hosting configuration was changed.

Property photos: POST /properties/:id/photos supports authenticated owner-only multipart upload with field name file. Allowed PNG, JPEG or WebP must have matching file content/MIME, be 1 byte–5 MiB and decode safely within 20 megapixels. Processing timeout is 10 seconds; images are re-encoded to remove EXIF/GPS. Maximum 20 active photos per home. Metadata is stored against the existing property ID in the private leri-property-photos-v2 bucket. No need to publish or recreate the property first. PATCH /properties/:id/photos/:photoId sets caption (<=300 characters) and position (0–1000). GET /properties/:id/photos lists the owner’s metadata; GET /properties/:id/photos/:photoId/download returns a 60-second signed URL under the existing access rules.

Current property-photo lists all returned 200, so ownership and read routes work. This audit inspected upload validation/implementation without sending uploads. No media availability or file-content check was possible because all seven lists are empty. Uploading photographs does not satisfy missing EPC/registration requirements or publish a draft. The running standard API was not switched to preview mode; renter visibility of illustrative draft homes remains subject to the separately gated preview capability. No preview implementation, installation or enablement occurred in this task.

Minimum assets and exact next steps

Recommended minimum for the complete six-person/seven-home showcase: 13 distinct assets — six fictional character portraits and one illustrative interior/hero image for each of the seven homes. Extra galleries are optional. Use synthetic faces and synthetic or appropriately licensed interiors; record asset provenance. Avoid verification badges, official-document imagery, identifiable private addresses and claims that interiors depict actual homes.

1. Approve/source six fictional portraits and seven distinct illustrative interiors. Map them explicitly to the six existing account IDs and seven property IDs in demo/preview-allowlist.json; keep source/licence and an internal synthetic-asset label. No new accounts or properties are needed.

2. Host the six portraits at approved durable public HTTPS URLs reachable from the iOS Simulator. Confirm HTTP 200, image content type, successful decoding and a useful crop before editing profiles. Do not place real documents or secrets on that host. A hosting/upload feature is separate work if no suitable host exists.

3. Sign in as each existing person using demo/showcase.credentials.local without logging passwords/tokens. Read GET /me/profile first. PATCH only photoUrl to that person’s mapped asset URL; skip a URL already set to the approved value. Verify the profile/portrait response afterward. Keep the synthetic demo label visible and all checks unverified; never send verification fields.

4. Sign in as each property’s existing landlord. Read GET /properties/:id/photos first to avoid duplicate uploads. Upload one mapped interior to the same existing property ID using multipart file; retain its returned photo ID. Immediately PATCH the caption to “Illustrative synthetic interior — not an actual home.” and position 0. Keep a local asset-to-photo-ID manifest, compare before reruns, and resume caption updates on an existing photo rather than uploading again. The upload endpoint itself does not deduplicate equal images.

5. Verify owner photo metadata and fetch each short-lived download URL to confirm usable image content. Separately verify renter-facing access through the already-approved preview setup when deliberately enabled for the showcase; do not change publication status, EPC/registration data or verification to make photos visible. Confirm the frontend displays the illustrative/demo label. This audit does not enable that setup.

6. Recheck all six profiles, seven draft IDs, nine connections and six messages after asset population. Confirm the same role/account IDs/passwords, one incoming/one outgoing pending/one accepted connection per person, and two messages per accepted conversation.

Preservation checks

Confirmed exactly six approved accounts, seven existing draft homes, nine connections between the demo people and six messages. Each person’s authenticated connection list returned three connections, and the accepted conversation returned two messages. Whole-row counts/hashes before and after were identical for users, renter/landlord profiles, renter preferences, properties, evidence, connections, messages and photo metadata. No duplicates, reseeding, migrations, publication changes, status changes or source/configuration edits occurred. The existing API was left running.

Raw non-secret audit evidence is in gitignored mode-0600 demo/readiness-audit.local. Local login credentials remain in gitignored mode-0600 demo/showcase.credentials.local. Only this report and the gitignored audit output were added in the workspace; the one-off audit script ran from /private/tmp.

Stopped after audit and report.
