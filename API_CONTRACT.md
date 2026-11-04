# Lérí backend API contract — MVP demo capabilities

Implemented 14 October 2026 for the 29 October demo. Product source: `Leri app des.pdf`. This document covers implemented profiles/privacy, flexible evidence, private uploads, landlord ARCS preferences and detailed properties. People discovery, person connections and accepted-only chat are now implemented in the increments below.

## Transport, authentication and errors

JSON request/response bodies use camelCase. All routes below except `GET /legal/documents` require `Authorization: Bearer <Supabase access token>`. Existing Supabase signup/login and `/me` remain supported; no authentication provider changes. The role comes from `public.users`, not a client-supplied role or the token's generic `authenticated` role.

Profile routes require a renter or landlord account. Privacy routes support any provisioned authenticated account. Path IDs must be UUIDs. Unknown JSON body fields are rejected, including verification, role, user ID, identity documents and private financial fields. Updates act on the session user only. New routes do not calculate renter scores or change existing records into consented connections.

| Status | Meaning |
|---|---|
| 200 | Successful GET/PATCH/PUT or explicit legal acknowledgement/acceptance |
| 400 | Invalid UUID/body, unknown field, wrong-role field, empty update, invalid budget range |
| 401 | Missing/invalid/expired Supabase session |
| 403 | Profile operation by an unsupported account role |
| 404 | Missing profile/account or profile not visible; same response for unknown, private and same-role profiles |
| 409 | Submitted legal version is not the currently published version; fetch documents again |
| 503 | Published terms and privacy notice have not both been configured |

Validation errors use Nest's standard `{ "statusCode": 400, "message": ["field validation message"], "error": "Bad Request" }`; service errors may use a string `message`. Never depend on the wording to determine authorization.

## Current profile

- `GET /me/profile`: own full editable profile and safe verification statuses.
- `PATCH /me/profile`: partial update; returns the updated own profile. At least one editable field required. Omitted fields retain their values. Explicit `null` clears nullable fields. Arrays/booleans and `displayName` cannot be null.
- `GET /me/profile/preview`: exactly the public projection of your own profile, including when `discoverable` is false.
- `GET /profiles/:id`: safe opposite-role public profile. Requires target `discoverable: true`; own profile can also be viewed. Landlord profiles include available public properties and ARCS preferences; renter profiles include safe evidence summaries. Same-role other users return 404.

Existing users start with `discoverable: false`; publishing their story/profile is an explicit owner choice. This does not change the existing landlord endpoint's published-property eligibility rule.

### Editable request fields

| Both roles | Type / validation |
|---|---|
| `displayName` | string, 1–100 characters, not whitespace-only |
| `bio` | string up to 2,000 characters or null |
| `photoUrl` | public HTTPS portrait URL, up to 2,048 characters, no embedded credentials; or null |
| `discoverable` | boolean; controls the new cross-user profile endpoint |

`photoUrl` is deliberately public. Do not put document URLs, identity scans, private storage links or sensitive information into portraits/bios/prompts. Supporting documents use the private upload endpoints described below. Supplying a photo does **not** verify it; changing it clears existing photo verification.

| Renter only | Type / validation |
|---|---|
| `currentLocation` | string up to 100 characters or null; owner-only |
| `preferredLocation` | string up to 100 characters or null |
| `budgetMin`, `budgetMax` | number, 0–99,999,999.99, max two decimals, or null; GBP monthly budget; min ≤ max when both set |
| `targetMoveDate` | calendar date `YYYY-MM-DD` or null |
| `tenancyLengthMonths` | integer 1–120 or null |
| `householdSize` | integer 1–30 or null |
| `householdType` | `single` / `couple` / `family` / `sharers` or null |
| `householdPreferences` | unique array of `pet_friendly`, `smoke_free`, `sharing`; empty array clears |
| `personalStory` | optional string up to 3,000 characters or null |

Renter prompt: “Beyond the paperwork, why would you make a great tenant?” Budget/location/duration/type continue to use the existing `renter_preferences` table. Profile/preference writes are atomic; partial budget changes are checked against the saved other bound.

```json
{
  "displayName": "Demo renter",
  "bio": "Looking for a long-term home in Edinburgh.",
  "personalStory": "I look after shared spaces and communicate early.",
  "preferredLocation": "Edinburgh",
  "budgetMin": 700,
  "budgetMax": 1100,
  "targetMoveDate": "2026-11-01",
  "tenancyLengthMonths": 12,
  "householdSize": 2,
  "householdType": "couple",
  "householdPreferences": ["smoke_free"],
  "discoverable": true
}
```

| Landlord only | Type / validation |
|---|---|
| `companyName` | string up to 150 characters or null |
| `landlordType` | `individual` / `company` / `agent` or null |
| `lettingExperienceYears` | integer 0–100 or null |
| `numberOfProperties` | integer 0–100,000 or null; self-declared portfolio size |
| `locationsCovered` | unique string array, at most 50 nonblank entries, each up to 100 characters |
| `communicationStyle` | string up to 1,000 characters or null |
| `lettingApproach` | string up to 2,000 characters or null |
| `tenantExpectations` | string up to 3,000 characters or null |
| `tenancySuccess` | optional string up to 3,000 characters or null |
| `registrationNumbers` | unique string array, at most 50 nonblank entries, each up to 100 characters; owner-only |
| `registrationDetails` | string up to 2,000 characters or null; owner-only |

Landlord prompts: “What can a great tenant expect from you as a landlord?” (`tenantExpectations`) and “What makes a tenancy work well for you?” (`tenancySuccess`). Registration numbers are stored as submitted; this endpoint does not validate their authenticity. New/changed nonempty registration submissions become `pending`; removing all numbers becomes `unverified`. Changing registration details invalidates any old successful registration check.

```json
{
  "landlordType": "individual",
  "locationsCovered": ["Edinburgh"],
  "lettingExperienceYears": 3,
  "numberOfProperties": 2,
  "tenantExpectations": "Prompt repairs and clear communication.",
  "tenancySuccess": "Mutual respect and early conversations.",
  "registrationNumbers": ["SYNTHETIC-DEMO-NUMBER"],
  "discoverable": true
}
```

### Response types

All keys below are present. Nullable values are `null` until supplied. Timestamps are ISO 8601 strings; move dates are `YYYY-MM-DD` strings. No caller can set `verification` or demo provenance.

```ts
type CheckStatus = 'unverified' | 'pending' | 'verified' | 'failed' | 'expired';
type PhotoStatus = 'unverified' | 'pending' | 'verified';
type Verification = {
  identityStatus: CheckStatus;
  photoStatus: PhotoStatus;
  mode: 'real' | 'demo'; // demo results must be visibly labelled as mock/demo
};
type PublicBase = {
  id: string;
  displayName: string;
  bio: string | null;
  photoUrl: string | null;
  memberSince: string;
};
type PublicRenterProfile = PublicBase & {
  kind: 'renter';
  evidenceSummary: EvidenceStrandSummary[];
  personalStory: string | null;
  preferredLocation: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  targetMoveDate: string | null;
  tenancyLengthMonths: number | null;
  householdSize: number | null;
  householdType: 'single' | 'couple' | 'family' | 'sharers' | null;
  householdPreferences: ('pet_friendly' | 'smoke_free' | 'sharing')[];
  verification: Verification;
};
type PublicLandlordProfile = PublicBase & {
  kind: 'landlord';
  arcsPreferences: ArcsPreferences;
  properties: PublicProperty[];
  companyName: string | null;
  landlordType: 'individual' | 'company' | 'agent' | null;
  lettingExperienceYears: number | null;
  numberOfProperties: number | null;
  locationsCovered: string[];
  communicationStyle: string | null;
  lettingApproach: string | null;
  tenantExpectations: string | null;
  tenancySuccess: string | null;
  verification: Verification & { registrationStatus: CheckStatus };
};
type OwnRenterProfile = PublicRenterProfile & {
  currentLocation: string | null;
  discoverable: boolean;
  updatedAt: string;
};
type OwnLandlordProfile = PublicLandlordProfile & {
  registrationNumbers: string[];
  registrationDetails: string | null;
  discoverable: boolean;
  updatedAt: string;
};
```

Public profiles never contain email, phone, date of birth, institution IDs, current renter location, registration numbers/details, provider/check tokens, evidence payloads/documents, private file references, financial account data or scores. Budgets are stated housing preferences, not verified income. Evidence-category summaries contain categories and simple statuses only, never explanations or document links. Public queries and preview use the same explicit SQL projection; base tables are not made broadly readable.

Identity and registration verification require server-managed provider/check references and timestamps. No real provider integration or verification-write HTTP route is included. Only a trusted verification integration should record successful checks. Demo flags are server-managed for synthetic fixtures and cannot be self-assigned.

## Legal documents, terms and optional consent

`GET /legal/documents` is public and returns the latest published version of each document:

```ts
type LegalDocument = {
  id: string;
  kind: 'terms' | 'privacy_notice';
  version: string;
  title: string;
  content: string; // plain text; render as text, not unsanitized HTML
  publishedAt: string;
  demoOnly: boolean;
};
type LegalDocuments = { terms: LegalDocument; privacyNotice: LegalDocument };
```

Draft/future documents are excluded. If either document is absent, the API returns 503. No placeholder legal content is silently published. Published versions are immutable; publish changes as a new version. For configuration see [LEGAL_CONTENT_SETUP.md](LEGAL_CONTENT_SETUP.md).

| Method/path | Body | Response |
|---|---|---|
| `POST /me/privacy/terms-acceptance` | `{ "termsVersion": "v1", "accepted": true }` | `{ "version": "v1", "acceptedAt": "ISO timestamp" }` |
| `POST /me/privacy/notice-acknowledgement` | `{ "privacyNoticeVersion": "v1", "acknowledged": true }` | `{ "version": "v1", "acknowledgedAt": "ISO timestamp" }` |
| `PUT /me/privacy/consents` | `{ "purpose": "user_research", "granted": false, "privacyNoticeVersion": "v1" }` | `{ "id": "UUID", "purpose": "user_research", "granted": false, "recordedAt": "ISO timestamp", "privacyNoticeVersion": "v1" }` |
| `GET /me/privacy` | none | `PrivacyState` below |

Only the current published version is accepted on writes. Terms/notice retries return the original timestamp. Acceptance cannot be posted with `false`. A privacy acknowledgement records that information was reviewed; it is separate from optional consent. Terms acceptance does not enable any optional consent. Optional choices default to false and can be withdrawn with `granted: false`; changes append history and never overwrite earlier events. Latest state is ordered by a monotonic database sequence, including events sharing a timestamp.

```ts
type ConsentPurpose = 'product_updates' | 'user_research';
type PrivacyState = {
  termsAcceptances: { version: string; acceptedAt: string }[];
  privacyAcknowledgements: { version: string; acknowledgedAt: string }[];
  consents: {
    purpose: ConsentPurpose;
    granted: boolean;
    privacyNoticeVersion: string | null;
    recordedAt: string | null;
  }[]; // always both purposes; unset entries have false/null/null
};
```

Records belong to the session user. Other users cannot read them or submit acknowledgements on their behalf. API credentials cannot rewrite history, backdate acknowledgements or publish legal text. Existing auth signup and other working APIs are not newly gated by acceptance; the frontend should present the documents and record these choices during onboarding.

## Configurable ARCS catalogue

`GET /evidence/catalogue` requires authentication and returns:

```ts
type EvidenceOption = {
  id: string; // stable namespaced key, e.g. 'affordability.payslips'
  pillar: 'affordability' | 'reliability' | 'community' | 'stability';
  label: string;
  displayOrder: number;
};
// Response: EvidenceOption[]
```

Seeded options: 16 affordability, 13 reliability, 14 community, 11 stability. Every option is optional. Labels/order/active state are developer-managed SQL data; API callers cannot edit the menu. Retire an option with `active=false` instead of deleting it or associated evidence. Historical free-form pathway strings and payloads remain supported. Modern selections use validated catalogue IDs and separate explanations; see below.

## Compatibility with existing routes

Existing `/me`, evidence CRUD/withdrawal, owner property management and tenancy-interest APIs remain. **Privacy correction:** `GET /landlords/:id` property cards now return `{ id, city, bedrooms, rentAmount }`; `addressLine1` has been removed from this public profile response. Root profile fields remain `{ id, displayName, memberSince, properties }`. Update any frontend/shared type that assumed a full address there.

The property feed and property-based tenancy interests remain compatibility endpoints. The approved frontend journey browses people, and renders properties inside landlord profiles only; no property application/connection action is added. Renter-facing legacy property/detail/feed/interest responses now omit full addresses and full postcodes. Raw property rows are owner-only under RLS. Owners retain their private address access. Existing shared frontend property/interest types that require these private fields must be updated to the safe response shapes below. Historical rows and draft/published/archived statuses are retained.

## Editable ARCS selections and explanations

`POST /evidence` retains `{ pillar, pathwayType, payload }` for legacy callers and additionally accepts:

```json
{
  "pillar": "affordability",
  "catalogueId": "affordability.savings",
  "explanation": "Synthetic explanation of my circumstances"
}
```

`catalogueId` must be an active option belonging to the chosen pillar. `payload` is optional, defaults to `{}`, and remains private. If `pathwayType` is also supplied with a catalogue selection it must equal `catalogueId`; otherwise legacy nonempty pathway strings remain valid. Explanations are optional, nullable strings up to 3,000 characters. Multiple different choices in any strand are allowed; no strand/file/pathway is mandatory. A duplicate active submitted selection returns 409. After withdrawal/deselection, that option can be selected again as a new historical record.

Modern owner responses extend `EvidenceItem` with `catalogueId`, `explanation`, `updatedAt`. Legacy records with neither catalogue ID nor explanation keep their original response shape. No response exposes a file-storage path. Evidence `status` remains the internal submitted/verified/rejected/withdrawn lifecycle; use summaries for public labels.

| Method/path | Body | Behavior |
|---|---|---|
| `PATCH /evidence/:id` | `{ "explanation": "Updated context", "catalogueId": "affordability.combined_income" }` (either field) | Edit submitted own evidence; category changes remain within the original pillar; returns owner evidence |
| `DELETE /evidence/:id` | none | Deselect own evidence, remove its supporting objects and mark retained records removed; returns `{ "removed": true }` |
| `GET /evidence/summary` | none | Current renter's four-strand safe summary |

Empty edits/unknown fields/invalid options → 400; another renter's item → 404; non-renter edits → 403; editing non-submitted evidence → 409. Pillar, renter ID, creation time and status are not editable. Existing `/evidence/:id/withdraw` stays supported; withdrawn/deselected evidence is excluded from public summaries. Deselecting does not delete the historical evidence row or change a server-controlled verification result.

```ts
type EvidenceStrandSummary = {
  pillar: 'affordability' | 'reliability' | 'community' | 'stability';
  status: 'Information added' | 'Document uploaded' | 'Not provided';
  categories: {
    catalogueId: string | null;
    label: string;
    status: 'Information added' | 'Document uploaded';
  }[];
};
// GET /evidence/summary and PublicRenterProfile.evidenceSummary: EvidenceStrandSummary[]
```

Summaries do not contain explanations, payloads, filenames, evidence/document IDs, storage paths, account details or grades. Unmapped legacy pathways use the label “Other information” rather than echoing user-supplied text. Retired catalogue choices remain understandable in historical selections. These summaries are included in the existing safe profile/preview projection and are never ranking inputs.

## Private supporting documents

All routes require a real Supabase bearer session and ownership of the parent evidence item. No service-role key is used by the backend Storage client. Supabase Storage enforces the same ownership through `auth.uid()` policies.

| Method/path | Request | Response |
|---|---|---|
| `POST /evidence/:id/documents` | `multipart/form-data`, one `file` field | 201 `EvidenceDocument` |
| `GET /evidence/:id/documents` | none | `EvidenceDocument[]` of active files |
| `GET /evidence/:id/documents/:documentId/download` | none | `{ "url": "short-lived signed URL", "expiresIn": 60 }` |
| `DELETE /evidence/:id/documents/:documentId` | none | `{ "removed": true }` |

```ts
type EvidenceDocument = {
  id: string;
  evidenceId: string;
  fileName: string; // private owner metadata; never copied to public profiles
  mimeType: 'application/pdf' | 'image/png' | 'image/jpeg';
  sizeBytes: number;
  createdAt: string;
};
```

Files must be nonempty, at most **5 MiB**, with matching format signatures. PDFs must include a PDF header/end marker. SVG, HTML and unsupported types are rejected. Maximum ten active documents per evidence item; file count changes are serialized on the parent row. Uploading to withdrawn/deselected or other users' evidence is rejected. Documents may be removed from the owner's other historical statuses without fabricating a status transition.

Let the browser set the multipart boundary; attach the Supabase token in `Authorization`. Upload routes use only the `file` part; additional text fields are ignored. Ownership, object keys and status always come from the server/session, never multipart fields. The bucket `leri-evidence-private-v2` is private, with MIME/size limits and owner-scoped object keys. There are no public document URLs or overwrite/upsert permissions. Supporting files are not attached to profiles or connection requests automatically. Signed URLs are temporary bearer credentials: do not log, publish or share them unintentionally.

Invalid/missing file → 400; multipart size limit → 413; unknown/other owner's resource → 404; non-renter → 403; storage service failure → 503. Successful removal deletes the Storage object and retains removed metadata; subsequent download requests return 404. Database rollback/commit failure triggers upload compensation. Storage and PostgreSQL are separate systems: failed/interrupted deletion can leave metadata awaiting reconciliation; retry removal. A failed compensation is logged for maintenance.

Demo uploads must be synthetic files. Reviewed legal content, retention/deletion procedures and the real-data privacy review remain requirements before collecting real sensitive evidence.

## Landlord ARCS defaults and property overrides

All write/read management routes below require the current landlord; property routes also require ownership. Preferences provide context and never exclude or rank renters.

```ts
type ArcsPreferences = {
  // Exactly four distinct pillars; array positions represent ranks 1, 2, 3, 4.
  priorityOrder: ('affordability' | 'reliability' | 'community' | 'stability')[];
  evidencePreferences: Record<string, 'accept' | 'prefer' | 'not_needed'>;
};
```

| Method/path | Body | Response |
|---|---|---|
| `GET /landlords/me/arcs-preferences` | none | `ArcsPreferences` |
| `PUT /landlords/me/arcs-preferences` | Complete `ArcsPreferences` | Saved `ArcsPreferences` |
| `GET /properties/:id/arcs-preferences` | none | `{ mode: 'default' \| 'custom', effective: ArcsPreferences, override: ArcsPreferences \| null }` |
| `PUT /properties/:id/arcs-preferences` | `{ "mode": "default" }` OR `{ "mode": "custom", "priorityOrder": [...], "evidencePreferences": {...} }` | Same effective/mode/override response |

Missing defaults use the initial A/R/C/S order and an empty evidence-choice map. Missing option keys mean unspecified, not rejection. A saved map replaces the previous map, so `{}` clears it. Choices must reference active catalogue IDs with exactly `accept`/`prefer`/`not_needed`; arbitrary fields, proxy screening criteria, null choices and unknown IDs are rejected (400). Default mode rejects simultaneous custom settings; custom mode requires the complete ranking/map.

Properties inherit subsequent changes to landlord defaults while in default mode. Custom mode uses a retained per-property row. Switching back to default retains the previous override for the owner's inspection/reuse; it does not delete history. Legacy preference rows remain unchanged. Effective settings are included in safe public landlord/property responses for understanding profiles, not for discovery filtering. Another landlord cannot read/edit private management state (404 on property resources); renters cannot manage preferences (403 on landlord routes).

## Complete property details and availability

Existing property create/list/read/patch/publish/archive routes remain. New request data uses a typed `details` object alongside the existing title/description/address/city/postcode/bedrooms/rent/rules fields:

```json
{
  "title": "Synthetic Edinburgh flat",
  "addressLine1": "Private address, owner only",
  "city": "Edinburgh",
  "postcode": "EH1 1AA",
  "bedrooms": 2,
  "rentAmount": 1250,
  "propertyRules": ["no_smoking"],
  "details": {
    "privateReference": "Owner's private reference",
    "publicArea": "Central Edinburgh",
    "postcodeDistrict": "EH1",
    "depositAmount": 1500,
    "billsIncluded": ["water"],
    "billsExcluded": ["gas", "electricity", "internet"],
    "availableFrom": "2026-11-01",
    "minTenancyMonths": 6,
    "expectedTenancyMonths": 12,
    "propertyType": "flat",
    "bathrooms": 1,
    "permittedOccupants": 2,
    "furnishing": "furnished",
    "keyFeatures": ["Bright living room"],
    "councilTaxBand": "D",
    "epcRating": "C",
    "hmoLicenceStatus": "not_required",
    "registrationNumbers": ["SYNTHETIC-DEMO-ONLY"],
    "registrationDetails": "Private owner submission",
    "heating": "Gas central heating",
    "energyFeatures": ["Double glazing"],
    "parking": "On-street",
    "outdoorSpace": "Shared garden",
    "accessibilityFeatures": ["Ground floor"],
    "petsPolicy": "considered",
    "smokingPolicy": "not_allowed",
    "otherConditions": "Respect shared spaces",
    "walkthroughUrl": "https://example.com/synthetic-tour",
    "walkthroughType": "video"
  }
}
```

`PATCH /properties/:id` merges supplied `details` keys with the stored details; it does not erase omitted keys. Nullable scalar keys can be cleared with null; arrays require arrays (use `[]` to clear). Unknown keys are rejected. Validation checks the merged state, including min/expected duration and overlapping included/excluded bills, under a row lock.

| Detail field | Type / limits |
|---|---|
| `privateReference` | private string ≤100 or null |
| `publicArea` | public string ≤150 or null |
| `postcodeDistrict` | uppercase UK district only, e.g. `EH1`; full postcode rejected |
| `depositAmount` | number 0–99,999,999.99, at most two decimals, or null |
| `billsIncluded`, `billsExcluded` | unique arrays from gas/electricity/water/internet/council_tax; disjoint |
| `availableFrom` | valid `YYYY-MM-DD` or null |
| `minTenancyMonths`, `expectedTenancyMonths` | integers 1–120 or null; minimum ≤ expected |
| `propertyType` | flat/house/room/studio/other or null |
| `bathrooms`, `permittedOccupants` | integers 0–20 and 1–30 respectively, or null |
| `furnishing` | furnished/part_furnished/unfurnished or null |
| `keyFeatures`, `energyFeatures`, `accessibilityFeatures` | up to 30 strings each, ≤200 characters per entry |
| `councilTaxBand` | A–H/exempt or null |
| `epcRating` | A–G/exempt or null |
| `hmoLicenceStatus` | not_required/pending/licensed/unknown or null |
| `hmoLicenceDetails` | private string ≤2,000 or null; required when status is licensed |
| `registrationNumbers`, `registrationDetails` | private array of up to 50 strings ≤100; private text ≤2,000 or null |
| `heating`, `parking`, `outdoorSpace` | public strings ≤200 / ≤200 / ≤500 or null |
| `petsPolicy`, `smokingPolicy` | allowed/not_allowed/considered; allowed/not_allowed respectively, or null |
| `otherConditions` | public string ≤2,000 or null; lawful conditions only, subject to fairness review |
| `walkthroughUrl`, `walkthroughType` | public HTTPS URL ≤2,048, no embedded credentials; video/live; set/clear together |

Registration submissions and HMO licence data are recorded information, not successful checks or legal compliance certification. They do not approve identity/registration verification.

For properties using modern details, publishing/returning to available requires public area/district, deposit, availability date, minimum duration, type, bathrooms/occupancy, furnishing, council tax/EPC, HMO status, registration numbers and at least one photo. Incomplete drafts can still be saved. Historic/minimal CRUD with empty details remains compatible and does not retrospectively require these fields. Clients building the MVP should submit the full details and photo workflow.

`POST /properties/:id/availability` accepts `{ "status": "available" }` or `{ "status": "unavailable" }`, returns 200 owner property plus `listingStatus`, and requires a published, non-archived owned listing. Unavailable properties/photos disappear from new public reads. Archived listings stay terminal; availability cannot revive them.

The original stored/API `status` remains draft/published/archived for compatibility. Modern owner responses add `details` and `listingStatus` (draft/available/unavailable). Old minimal owner responses keep their existing shape. Public properties always provide `listingStatus: 'available'`; unavailable/draft/archived properties return 404 publicly. With `REQUIRE_VERIFICATION=true`, publishing/availability requires real successful identity and registration checks, not a legacy status string or demo flag.

## Property gallery and landlord-nested browsing

| Method/path | Request | Response |
|---|---|---|
| `GET /properties/:id/photos` | owner only | `OwnerPropertyPhoto[]` |
| `POST /properties/:id/photos` | owner, multipart one `file` | 201 `OwnerPropertyPhoto` |
| `PATCH /properties/:id/photos/:photoId` | owner, `{ "caption": "Living room", "position": 1 }` (either field) | Updated `OwnerPropertyPhoto` |
| `DELETE /properties/:id/photos/:photoId` | owner | `{ "removed": true }`; actual object removed, metadata retained |
| `GET /properties/:id/photos/:photoId/download` | owner, or renter while available | `{ url: string, expiresIn: 60 }` |
| `GET /landlords/:landlordId/properties` | renter, or owner landlord | `PublicProperty[]`, available only, max 100 |
| `GET /landlords/:landlordId/properties/:id` | renter, or owner landlord | `PublicProperty`; 404 on wrong landlord/property pairing |
| `GET /landlords/:landlordId/properties/:id/photos/:photoId/download` | same visibility | Short-lived photo URL |

```ts
type PublicPropertyPhoto = {
  id: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  caption: string | null; position: number;
};
type OwnerPropertyPhoto = PublicPropertyPhoto & {
  propertyId: string; fileName: string; sizeBytes: number; createdAt: string;
};
type PublicProperty = {
  id: string; landlordId: string; title: string | null; description: string | null;
  city: string; bedrooms: number; rentAmount: number; currency: string;
  propertyRules: string[]; status: 'published'; listingStatus: 'available';
  publishedAt: string; archivedAt: null; createdAt: string; updatedAt: string;
  details: PublicPropertyDetails;
  arcsPreferences: ArcsPreferences;
  photos: PublicPropertyPhoto[];
};
// PublicPropertyDetails contains only public fields from the details table above.
// It never includes privateReference, registrationNumbers, registrationDetails or hmoLicenceDetails.
```

Photos support PNG/JPEG/WebP only, maximum **5 MiB** and **20 megapixels**, at most **20 active photos** per property. They are decoded and re-encoded before storage to strip EXIF/GPS and other metadata; invalid image content is rejected. Animated inputs are reduced to a still image. Public captions are limited to 300 characters; positions are integers 0–1,000, ordered by position then ID. The `leri-property-photos-v2` bucket is private; renters receive short-lived access only for active photos of available published listings. Original filenames/object paths are never in public gallery metadata.

Removing the final photo from a modern published listing makes it unavailable. Owners may still remove/download retained photos from archived listings, but cannot upload/edit photos on an archived listing. Availability changes invalidate new access requests immediately; previously issued photo URLs can remain valid for their remaining 60-second lifetime. File removal deletes the underlying object.

Public projections are explicit allowlists in PostgreSQL. Private addresses, full postcodes, private references, registration numbers/details, HMO licence details, document pointers and embedded EXIF/GPS metadata are excluded from all renter-facing property/profile/interest responses. Public area/postcode district are shown; legacy districts are derived conservatively from stored postcodes. Raw properties and full renter profile rows are no longer readable across users even through historical applicant relationships. Owner management responses retain private information.

Properties are view-only in the approved renter journey. Render them inside the landlord profile with Back to landlord profile; connection requests target the person using `/connections` below. The legacy `/properties` feed is retained solely for compatibility and returns the same safe projection; do not build a separate renter property-search tab from it.

## Phase 2 runtime and migration requirements

Apply `20261014140000_phase2_evidence_properties.sql` and `20261014141000_phase2_private_storage.sql` only on an authorised target. They extend existing tables without deleting records, add private media metadata, configure new private buckets/policies and replace cross-user raw-table visibility with safe functions. Existing owner CRUD, original status history, legacy evidence payloads and legacy landlord preference rows are preserved.

Runtime requires `DATABASE_URL` for the non-superuser/non-BYPASSRLS `app_user`, matching `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Storage requests use the current user's verified Supabase session token. Sharp is a runtime dependency for safe gallery image processing. No production changes or migration application are performed by the backend itself.

Image processing reference: [Sharp output metadata behavior](https://sharp.pixelplumbing.com/api-output/) and [input pixel limits](https://sharp.pixelplumbing.com/api-constructor/). Application limits and metadata removal are covered by automated tests.

### Local Expo connectivity (14 October 2026)

The Nest API has no global `/api` prefix and listens on port `3000`.
Start against the existing isolated validation stack without migrations or resets:

```sh
LERI_SUPABASE_TEST_WORKDIR=/private/tmp/leri-supabase-phase2-20261014-final npm run start:isolated
```

This command ignores the project's `.env`, uses restricted `app_user` on
`127.0.0.1:55322/postgres`, and verifies Auth against `http://127.0.0.1:55321`.
The isolated Supabase services must already be running.

| Client | EXPO_PUBLIC_API_URL | EXPO_PUBLIC_SUPABASE_URL |
| --- | --- | --- |
| iOS Simulator | `http://localhost:3000` | `http://localhost:55321` |
| Android Emulator | `http://10.0.2.2:3000` | `http://10.0.2.2:55321` |
| Physical device on the same LAN | `http://192.168.1.146:3000` | `http://192.168.1.146:55321` |

Use the isolated stack's matching public anon key, never a service-role key.
Sign in again after switching Auth environments. Restart Expo after changing
`EXPO_PUBLIC_*` settings. LAN addresses may change; physical-device access also
requires the same reachable network and host firewall access. Device and emulator
requests have not been tested from actual devices in this investigation.

The isolated runner binds to `::` (verified IPv4 and IPv6 localhost connectivity)
and allows Expo web origins on ports `8081` and `19006` for localhost and current
LAN IPv4 addresses. `HOST`, `PORT`, and comma-separated `CORS_ORIGINS` can override
these settings. Ordinary startup only enables CORS when `CORS_ORIGINS` is supplied.
Native Expo clients do not use browser CORS.

Read-only checks: `GET /health` → `200 {"status":"ok","db":"ok"}`;
`GET /legal/documents` → `200`; unauthenticated `GET /me` → `401`.
Expo web preflight → `204` with the matching allowed origin; unrelated origins
receive no allow-origin header. Docker and isolated Auth, JWKS, REST and Storage
health checks passed. All 16 migrations were present; no migrations were applied.
Original development and production databases were untouched.


## People discovery increment — implemented 14 October 2026

`GET /discovery?mode=all|suggested&limit=20&after=<UUID>` requires a verified Supabase bearer session and renter/landlord role. Default mode is all; limit 1–50. Unknown filters/modes and malformed cursors return 400. Response: `{ items: Array<{ profile: PublicProfile, reasons: string[] }>, nextCursor: string | null }`. Reuses the existing safe public-profile projection, including truthful verification and safe ARCS/property summaries; no private profile, address or document data. Only discoverable opposite-role people appear.

Pagination is stable ascending profile UUID, not a suitability ranking. `nextCursor` refers to the last examined candidate. Suggested pages can be empty with a non-null cursor; continue until null. Suggestions require at least one known practical compatibility factor on an available property, with no conflicts in supplied area, GBP rent budget, move date, minimum duration, occupancy or explicitly incompatible pet/smoking preferences. Exact normalized area/city/district comparisons are used; no geocoding or inferred proximity. Missing inputs are not invented. No ARCS, identity verification or numerical trust/risk/match scores influence eligibility/order. Explore remains independent of suggestions. Landlord property data stays nested inside landlord profiles.

Validated with four real-auth isolated Supabase tests covering role/visibility, safe projections, suggestions vs Explore, paging, input validation and denied direct Supabase RPC access. Requires additive migration `20261014200000_people_discovery.sql`, applied only to isolated stack `leri-phase2-validation-20261014-final` (55321/55322); existing users preserved. No production migration/deployment.

## Person requests and messaging increment — implemented 14 October 2026

All endpoints use the existing Supabase JWT guard, server role lookup and transaction-local RLS context. Person requests are independent of historical `/tenancy-interests`; no historic match implies acceptance. Both people must make their profiles discoverable before a request can be created. The introduction may mention a property, but no property ID or application is created.

| Method/path | Body/query | Success |
|---|---|---|
| `POST /connections` | `{ "recipientId": "<opposite-role UUID>", "introduction": "A personalised note" }` | 201 `Connection` |
| `GET /connections` | Optional `direction=incoming|outgoing`, `status=pending|review_later|accepted|declined`, `limit=1..50` (default 20), `after=<UUID>` | `{ items: Connection[], nextCursor: string | null }` |
| `GET /connections/:id` | Participant only | 200 `Connection` |
| `POST /connections/:id/review-later` | Empty body; recipient only | 200 `Connection` |
| `POST /connections/:id/accept` | Empty body; recipient only | 200 `Connection` |
| `POST /connections/:id/decline` | Empty body; recipient only | 200 `Connection` |
| `GET /connections/:id/messages` | Accepted participant only; `limit=1..100` (default 50), `after=<message cursor>` | `{ items: Message[], nextCursor: string | null }` |
| `POST /connections/:id/messages` | Accepted participant only; `{ "text": "Hello" }` | 201 `Message` |

```ts
type Connection = {
  id: string; senderId: string; recipientId: string;
  introduction: string; status: 'pending' | 'review_later' | 'accepted' | 'declined';
  direction: 'incoming' | 'outgoing';
  createdAt: string; updatedAt: string; acceptedAt: string | null;
  conversationId: string | null; // the accepted connection's ID, not a property/interest ID
  counterparty: PublicProfile | null; // existing safe projection, current visibility applies
};
type Message = {
  id: string; connectionId: string; senderId: string;
  text: string; sentAt: string; cursor: string;
};
```

Notes: 1–3,000 characters, whitespace-only rejected, trimmed on save. Messages: 1–4,000 characters, whitespace-only rejected, trimmed, plain text. Unknown create/message JSON fields and unsupported query fields are rejected. IDs/timestamps/senders/status come from the server, not request bodies. UTC timestamps serialize as ISO strings. Connection pages use ascending UUID order; status/direction are independent filters. To display all outstanding requests include both pending and review_later, or omit status.

Transitions: `pending → review_later | accepted | declined`; `review_later → accepted | declined`. Repeating the current recipient decision returns the same stored state. Accepted/declined are terminal; competing decisions serialize under a row lock. One request per unordered person pair is enforced by a unique index, including reciprocal requests. Duplicate/reverse/retry creation returns 409 instead of auto-accepting. A declined pair cannot resend yet; reopening/withdrawal are not implemented.

Acceptance and chat eligibility commit atomically on the existing connection row. The conversation identifier equals that accepted connection ID, so no second relationship or parallel conversation system is created. Frontend may show “You’re Connected!” only after this successful response, with the clarification that connection guarantees no viewing, reservation, approval or tenancy. It may then open messages using that ID.

Both participants can read all request states, including declines and review-later. Only the original recipient can decide (sender receives 403); nonparticipants receive 404. Before acceptance, messages return 409. After acceptance, only the two participants can read/send; sender spoofing, direct nonparticipant SQL and direct ordinary Supabase table access are denied. Messages have no edit/delete endpoints or application privileges. Hiding a profile removes its content from `counterparty` (null), discovery and new-request eligibility; it does not cancel existing accepted communication. A dedicated block/report workflow is still pending.

Messages are chronological by server-generated monotonic cursor, independent of UUID order. Cursors are decimal strings of up to 18 digits; keep them as strings. Use `nextCursor` to page existing history and the last returned message's `cursor` to poll for newer messages after reaching the end. Empty history returns `items: []`, `nextCursor: null`. No WebSocket/push, delivery/read receipts, message attachments or retry idempotency keys are implemented. POST retries can create another message; display success only after the response.

Requires additive migrations `20261014210000_person_connections.sql` and `20261014211000_message_permissions.sql`, applied only to the isolated populated stack without resets/deletions. The latter removes an inherited default UPDATE grant in addition to RLS denial. Phase 1 and prior Phase 2 routes remain unchanged. Frontend integration has not been performed by this backend task.


### Final demo-backend validation

Final source passed TypeScript, strict full source/test lint, Nest build, 65 unit tests and 142 real-auth isolated Supabase HTTP/database/Storage tests (zero failures/skips). Includes the full synthetic private-evidence/two-properties/gallery/discovery/request/accept/chat journey and concurrent decision/message tests. HTTP sends are serialized per conversation to preserve polling cursor commit order. All 19 isolated migrations are present and the original data sentinels are unchanged. Live existing API on port 3000 returns 200 for both discovery modes and the participant connection list. Tests append synthetic records/legal versions; they never reset/purge existing data. See PHASE2_IMPLEMENTATION_REPORT.md for exact commands, file manifest and remaining limitations.
