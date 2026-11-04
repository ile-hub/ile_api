Publication and discovery diagnosis — 28 October 2026

Diagnosis only. No application fixes, migrations, matching changes, Auth logins or synthetic-record mutations were performed. The diagnostic uses BEGIN READ ONLY for all data queries, executes discovery as the existing restricted app_user with the appropriate account context, and invokes the existing compiled discoveryReasons function. Local diagnostic artifacts are the only files created. Raw results, live SQL definitions, constraints and triggers are in gitignored diagnostic.local.

Environment

Confirmed project leri-phase2-validation-20261014-final, workdir /private/tmp/leri-supabase-phase2-20261014-final, Supabase 127.0.0.1:55321, PostgreSQL 127.0.0.1:55322/postgres. Docker container identities, project-specific database volume and exact port mappings were rechecked. All 19 migrations exist; app_user is neither superuser nor BYPASSRLS. Original dev/production were not accessed. The old migration sentinel is missing, so historical sentinel preservation is not claimed.

Part A — publication

All seven homes are draft/available. Each has EPC null, postcodeDistrict absent, registrationNumbers [], and zero active photos. HMO is unknown, which is valid and is not a blocker. The other approved rental fields are populated.

PropertiesService.requireComplete (src/properties/properties.service.ts:450) requires the following non-null/nonempty scalar fields whenever details is nonempty: publicArea, postcodeDistrict, depositAmount, availableFrom, minTenancyMonths, propertyType, bathrooms, permittedOccupants, furnishing, councilTaxBand, epcRating, hmoLicenceStatus. It additionally requires at least one registrationNumbers entry. Only after these checks pass does it require at least one non-removed photo metadata row. Existing captured publication responses for all seven are HTTP 400: “Complete rental details and registration information are required before availability”. This diagnostic did not repeat POST publication requests.

| Field | API format / publication rule | Actual database constraint | Honest synthetic use |
|---|---|---|---|
| EPC | Optional/null in drafts; supplied value A, B, C, D, E, F, G or exempt. Publication requires non-null/nonempty. No unknown value in DTO. | Details CHECK allows null or string for EPC; it does not enforce the DTO’s EPC enum. Completeness is an application check. | Leave null. Neither a rating nor exempt can honestly mean unknown. Direct SQL insertion of an API-invalid unknown string is not an acceptable workaround. |
| Postcode district | Optional/null draft value; supplied value must match `^[A-Z]{1,2}[0-9][0-9A-Z]?$` (uppercase outward district, no spaces/inward code). Publication requires a value. `G41` is an example of accepted syntax, not an assignment to any home. | Same regex in leri_valid_property_details. Full address/postcode fields do not substitute for details.postcodeDistrict in requireComplete. | A clearly labelled approved demo district is practical location metadata, not legal verification. It still needs an approved value; this diagnosis assigns none. |
| Registration numbers | Property details registrationNumbers: unique array, max 50 strings, each max 100 characters; nonblank entries enforced by service. Publication needs a nonempty array. registrationDetails optional, max 2000 characters, not a substitute. There is no Scottish official-number syntax check or register lookup in this path. | JSON array of strings; no official-number regex, authenticity check, or nonempty-array publication constraint. Landlord-profile verified status separately requires registration numbers, nonblank check reference and verified timestamp. | Leave array empty and explanation explicitly unverified. A marker string could pass superficial syntax but would occupy an official-information field; it is not an existing distinguished demo-compliance mechanism and is not recommended. |
| Photos | Authenticated owner multipart file upload; decoded PNG/JPEG/WebP with matching signature/MIME, 1–5,242,880 bytes, max 20 megapixels, processing timeout 10 seconds; max 20 active photos per property. EXIF/GPS removed by re-encoding. Publication needs >=1 active metadata row. | Metadata MIME enum PNG/JPEG/WebP, size range, unique object_path, property/owner FKs, position 0–1000, caption <=300 characters. Owner/path RLS requires owner/property/photo IDs to agree. Identity/removal trigger prevents reassignment. Storage bucket access remains private/authenticated. | Fictional or appropriately licensed sample interiors, explicitly captioned illustrative/demo, can be uploaded normally. No identity or property verification success is implied. Do not insert metadata without an actual accessible image. |

The validator enforces presence, not legal authenticity. There is no property EPC-verification field here. These are findings about this implementation, not a statement of Scottish legal requirements.

Existing demo support

Profile is_demo produces verification.mode=demo; it does not bypass property completeness or change property visibility. The isolated runner sets REQUIRE_VERIFICATION=false, skipping only landlord identity/registration verification. If REQUIRE_VERIFICATION=true, the additional gate requires both checks verified AND rejects is_demo profiles. This flag is not a demo-publication facility.

Property states are draft, published and archived; availability is a separate available/unavailable value. The live status trigger allows draft->published or draft/published->archived and stamps dates; it does not enforce completeness. The public property projection requires published AND available, excludes private address/registration data, and is used inside landlord public profiles. Self-profile preview uses that same projection, so it does not reveal draft homes to renters. There is no existing demo-preview property state or cross-user draft-preview endpoint.

A legacy details={} path skips completeness. Clearing the seven details objects would discard approved data and exploit a compatibility exception; direct status updates would bypass the API. Neither is recommended or performed.

Recommended smallest safe remedy

Prefer an explicitly labelled, isolated-only demo preview over pretending these homes meet normal publication requirements:

1. Keep the seven records draft and preserve their IDs, EPC null, registrationNumbers [], HMO unknown and all approved practical details.
2. Add a narrowly gated safe projection of exactly the seven allowlisted property IDs under the three demo landlords, nested inside people-first profiles. Enable only in this exact isolated environment, default disabled, for allowlisted synthetic demo viewers and namespace-checked demo owners. is_demo alone is not sufficient authorization. Reuse the existing public-field allowlist; never expose raw owner property rows or private addresses/registration fields.
3. Make the projection’s presentation mode explicit (demo preview / illustrative home / compliance not checked) in profile, property detail and photo responses and in the UI. Add illustrative photos through the normal upload path. A marker must not assert identity, registration, EPC or HMO verification.
4. Pass that same safely projected property collection to the unchanged compatibilityReasons function for both roles. Cover nested profile, detail/list/photo routes consistently; otherwise discovery and profile details would disagree.
5. Leave normal publish(), requireComplete(), REQUIRE_VERIFICATION semantics and published-only production projections unchanged. Prove the preview is denied with the flag off, for non-allowlisted users/properties, on any other target, and without authentication.

This needs a small explicit API/projection feature, not a seed-only fix. Since public projections are database functions and app_user cannot read other owners’ raw drafts, a scoped SQL projection/function change may be necessary; its migration or isolated application requires explicit approval. No enum change is needed if drafts remain drafts. Returning a demo marker also needs frontend support before claiming presentation is clearly distinguished.

If the requirement remains literal status=published rather than visible-in-demo, that is a separate approval decision: a narrowly gated demo-publication policy and explicit property-level demo presentation would be needed. A global validator relaxation, production flag, fake registration number, fake EPC or manual status update is not recommended.

Risks: accidental flag deployment, excessive draft exposure, losing allowlist checks, inconsistent detail/photo authorization, treating previews as actual available listings, and clients hiding the demo label. Hard target guards, exact IDs, default-off behavior and negative access tests are necessary parts of the proposed change.

Classification: missing source/media data plus a code capability gap for honest demo preview. Current normal publication refusal is expected behavior, not a malfunction.

Part B — Suggested for You

Pipeline traced from ProfilesService.discover through leri_discovery and leri_public_profile/leri_public_properties/leri_public_property, then the existing compatibilityReasons function. The isolated database contains 199 users: 99 renters and 100 landlords.

The table counts distinct opposite-role people surviving cumulatively, not individual properties. All six account traces were executed independently; identical role totals are shown per person.

| Condition | Amina | David | Sarah | Jamie | Priya | Lewis |
|---|---:|---:|---:|---:|---:|---:|
| Other role, valid renter/landlord caller | 99 | 99 | 99 | 100 | 100 | 100 |
| Opposite profile discoverable / Explore All | 49 | 49 | 49 | 36 | 36 | 36 |
| At least one projected published/available home for pair | 0 | 0 | 0 | 14 | 14 | 14 |
| Preferred location matches city/area/district | 0 | 0 | 0 | 0 | 0 | 0 |
| GBP rent within stated budget | 0 | 0 | 0 | 0 | 0 | 0 |
| Available by structured move date, where both supplied | 0 | 0 | 0 | 0 | 0 | 0 |
| Tenancy length satisfies minimum, where both supplied | 0 | 0 | 0 | 0 | 0 | 0 |
| Household fits occupancy, where both supplied | 0 | 0 | 0 | 0 | 0 | 0 |
| Pet preference compatible | 0 | 0 | 0 | 0 | 0 | 0 |
| Smoke-free preference compatible | 0 | 0 | 0 | 0 | 0 | 0 |
| At least one plain-language compatibility reason / Suggested | 0 | 0 | 0 | 0 | 0 | 0 |

Landlords: each has zero projected published homes. Therefore each of 49 visible renter candidates has no property to compare; the loop immediately produces no reasons. All 49 are removed by the final reasons.length>0 filter. Their three/three/one drafts are not passed to matching.

Renters: 22 of 36 visible landlords have no projected available home. The remaining 14 have 17 homes, all Edinburgh. All 17 property comparisons fail the exact normalized Glasgow location preference, leaving no candidates for later checks. No Glasgow demo home reaches the matching function because all seven are drafts. Budget/date/tenancy/household/pet/smoking conditions cause no additional eliminations in this run: the set is already empty.

Structured preferences checked live:

| Renter | Preferred location | Budget max | Budget min | Move date | Tenancy months | Household size | Household preferences |
|---|---|---:|---|---|---|---|---|
| Jamie | Glasgow | 1000 | null | null | null | null | [] |
| Priya | Glasgow | 850 | null | null | null | null | [] |
| Lewis | Glasgow | 900 | null | null | null | null | [] |

Null optional preferences do not reject these people. Move months and longer-tenancy language are currently prose, not structured matching inputs. Therefore the algorithm cannot emit timing/longer-tenancy reasons from those statements. This is a data-completeness limitation, not the cause of the empty suggestions. Dates/tenancy/household values should only be filled after explicit approval; do not infer a particular day or duration from month-only prose.

Connections: each user has one accepted and two pending. leri_discovery has no connection join/exclusion; neither compatibilityReasons nor the public projections exclude existing connections. All three new opposite-role demo people remain in Explore despite the nine existing pair relationships.

ARCS, identity/photo/registration verification, income type and missing rental history do not participate in filtering/ranking. Landlord locationsCovered, biographies, bedroom wishes in prose, householdType and portfolio counts are not matching inputs either. Discovery returns people, with homes nested within landlord profiles.

Pagination was exhausted: each landlord 20/20/9 candidates; each renter 20/16. Every page returns zero suggestions, so this is not merely a first-page symptom. Source filters compatibility AFTER candidate pagination. That can legitimately produce an empty page with a non-null nextCursor, and a client stopping on an empty items array could miss later suggestions in another dataset. Here all pages were checked and no later suggestions exist. This is a separate pagination/UX hazard, not the present root cause; no pagination implementation was changed.

Read-only counterfactual from the seven approved draft prices/locations (not actual Suggested results): if those same homes were eligible for safe projection, using current structured preferences and unchanged rules, Jamie could fit Amina/David/Sarah; Priya could fit Amina only; Lewis could fit Amina/Sarah. Reverse demo-only candidates would be Amina: Jamie/Priya/Lewis, David: Jamie, Sarah: Jamie/Lewis. Reasons would include preferred area and rent fits stated budget. Move/term reasons would still be absent. This does not claim that draft homes are currently visible or recommended, and does not count retained historical renters against the landlords.

Classification: current empty Suggested results follow the intended publication dependency and genuinely mismatched Edinburgh historical data. No matching/query defect was found causing these six empty results. No weights/filter/ranking changes are indicated. Resolve safe demo property visibility first, then verify actual reasons and counts again; preserve Explore All independently.

Approval boundary

Explicit approval is required before implementing the isolated demo-preview projection and access gates, SQL-function/migration changes, any literal demo-publication exception, response/UI demo labels, new illustrative assets, new location/date/tenancy assignments, or changes to matching/pagination. No production validation relaxation is proposed. A separate review is needed if hardening the pre-existing legacy completeness exception or API/database validation differences is desired; those are outside this diagnosis.

Stopped after diagnosis. Existing accounts, seven drafts, nine connections, six messages and IDs were preserved.
