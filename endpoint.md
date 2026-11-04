# Ilé API — Endpoint List

Organized by domain, matching `schema.sql` and the renter/landlord screen breakdowns.
**Status column is honest, not aspirational** — most of this is designed, not built.
Built and covered by e2e tests (`npm run test:e2e`, against local Supabase):
`/me`, Evidence, Properties, Tenancy Interests.

**Conventions for built endpoints:** all require `Authorization: Bearer <Supabase
access token>`. Request/response bodies are camelCase and typed in
`@yourorg/ile-shared-types`. Unknown body fields are rejected (400). `:id` /
`:propertyId` must be UUIDs (400 otherwise). Anything the caller can't see is a
plain 404 — "doesn't exist" and "not yours" are deliberately indistinguishable.
Named actions (`/publish`, `/archive`, `/decline`, `/withdraw`) return 200;
creates return 201.

Scope excluded deliberately (per earlier decisions): `institution_admin` endpoints,
automated Scottish Landlord Register lookups, evidence reviewer/admin endpoints —
all pending real decisions, not oversights.

**Revision note:** this replaces the original Applications-based landlord decision
flow with mutual Tenancy Interests, per the matching redesign. See the callout in
that section for what's genuinely unresolved as a result.

---

## Auth & Session

Signup/login are NOT backend endpoints — handled directly by the Supabase client
SDK, with the `handle_new_user()` Postgres trigger doing atomic profile creation.

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| GET | `/me` | Current user: `{ id, email, role, displayName, profile }` — `profile` is `{ kind: 'renter', bio, institutionId, createdAt }` or `{ kind: 'landlord', companyName, verificationStatus, createdAt }` | Any authenticated | **Built** |

---

## Identity Verification (renters only)

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| POST | `/identity-verifications` | Initiate identity + right-to-rent check (Yoti flow) | Renter | Pending |
| GET | `/identity-verifications/me` | Check own verification status | Renter | Pending |
| POST | `/identity-verifications/webhook` | Provider callback with result | None (signature-verified) | Pending |

---

## Landlord Verification

Structurally separate from renter identity verification — no right-to-rent concept here.

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| POST | `/landlord-verifications/identity` | Initiate base identity check (no right-to-rent) | Landlord | Pending |
| POST | `/landlord-verifications/registration` | Submit landlord registration number (manual review for MVP) | Landlord | Pending |
| GET | `/landlord-verifications/me` | Check own verification status(es) | Landlord | Pending |
| POST | `/landlord-verifications/webhook` | Provider callback | None (signature-verified) | Pending |

---

## Evidence (renters only)

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| POST | `/evidence` | Submit `{ pillar, pathwayType, payload }` → `EvidenceItem`. Landlord → 403 | Renter | **Built** |
| GET | `/evidence` | List own evidence items | Renter | **Built** |
| GET | `/evidence/:id` | Get one evidence item | Renter | **Built** |
| POST | `/evidence/:id/withdraw` | Withdraw evidence (only legal `submitted→withdrawn` transition) | Renter | **Built** |

No generic `PATCH /evidence/:id` exists — no client-facing path to `verified`.
Reviewer-side endpoints remain intentionally undesigned, pending a reviewer-role decision.

---

## Trust Profile (renters only, read-mostly)

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| GET | `/trust-profile/me` | Current trust profile + pillar summaries | Renter | Pending — trust engine doesn't exist yet |
| GET | `/trust-profile/me/history` | Past (superseded) profile generations | Renter | Pending |

Profile generation is an internal service process (via the planned
`trust_engine_service` role), not a client-triggered action.

---

## Profile Disputes

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| POST | `/trust-profile/:id/disputes` | Raise a dispute on a trust profile | Renter | Pending |
| GET | `/disputes/me` | List own disputes | Renter | Pending |
| PATCH | `/disputes/:id` | Resolve a dispute | Platform admin | Pending — needs the admin seed script first |

---

## Preferences (matching inputs)

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| GET | `/renter-preferences/me` | Get own matching preferences | Renter | Pending |
| PUT | `/renter-preferences/me` | Set/update matching preferences | Renter | Pending |
| GET | `/properties/:id/landlord-preferences` | Get preferences for a property | Landlord (owner) | Pending |
| PUT | `/properties/:id/landlord-preferences` | Set/update preferences for a property | Landlord (owner) | Pending |

---

## Properties

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| POST | `/properties` | Create a property — always starts as `draft`. Body: `CreatePropertyRequest` | Landlord | **Built** |
| GET | `/properties/me` | List own properties, all statuses | Landlord | **Built** |
| GET | `/properties?limit=&offset=` | Renter feed: published only, newest first. `limit` 1–50 (default 20), `offset` ≥ 0. Returns `{ items, limit, offset, hasMore }`. Landlord → 403 | Renter | **Built** |
| GET | `/properties/:id` | One property. Owner sees any status; renters see published only | Landlord (owner) or renter (if published) | **Built** |
| PATCH | `/properties/:id` | Update details (any subset of the create fields; `status` rejected). Archived → 409 | Landlord (owner) | **Built** |
| POST | `/properties/:id/publish` | `draft → published`. Anything else → 409 | Landlord (owner) | **Built** |
| POST | `/properties/:id/archive` | `draft\|published → archived`. Archived is terminal | Landlord (owner) | **Built** |

No generic status setter. Visibility is enforced by RLS on `properties` (landlord: own
rows, full CRUD; renter: SELECT published only), and transitions by a DB trigger.

**Publish gate:** `REQUIRE_VERIFICATION` env flag (default `false`). When `true`,
publish requires `landlord_profiles.verification_status = 'verified'` (403 otherwise).
Nothing sets that status yet — landlord verification isn't built — so with the flag
on, nobody can publish.

`propertyRules` are slugs: `no_smoking`, `no_pets`, `sharers_ok`.

---

## Landlord Profile (renter-facing)

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| GET | `/landlords/:id` | Public landlord profile: `{ id, displayName, memberSince, properties: [{ id, addressLine1, city, bedrooms, rentAmount }] }` — published properties only, newest first | Renter (landlords → 403) | **Built** |

404 unless the landlord has at least one published property — the same 404 for
unknown ids and non-landlords, so it never confirms a landlord exists beyond what the
feed already shows. No email, phone, company name or verification status. Fields come
from the `landlord_public_profile()` SECURITY DEFINER function; the property list is
read under the renter's normal RLS (published rows only).

---

## Matching — compatibility score only, NOT the mutual-interest flow

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| GET | `/matches/me` | Renter's system-computed compatibility scores | Renter | Pending |
| GET | `/properties/:id/matches` | Landlord's view of compatibility scores for a property | Landlord (owner) | Pending |

**Important distinction, easy to blur:** this section is the automatic, computed
"how well do these preferences overlap" score — informational only, nobody acts on
it directly. It is NOT the same as Tenancy Interests below, which is the real,
human, mutual-consent flow. Don't let these two get conflated in code or naming —
that mistake was caught once already this session.

---

## Tenancy Interests — mutual matching (replaces the old Applications-based decision flow)

Exactly two actions exist anywhere in this flow: **Interested** and **Not a fit**.
There is no "Shortlist" or third/intermediate state.

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| POST | `/tenancy-interests` | Express interest — see request body note below. Property must be published | Renter or Landlord (owner) | **Built** |
| POST | `/tenancy-interests/:id/decline` | Decline — silent to the other party, no reason exposed | Renter or Landlord (owner) | **Built** |
| GET | `/tenancy-interests/me?status=` | All of the caller's rows (renter: own interests; landlord: across all their properties). No `status` = everything except declined; `status` = `pending`\|`matched`\|`declined` | Renter or Landlord | **Built** |
| GET | `/tenancy-interests/:id` | One row the caller is a party to | Renter or Landlord (owner) | **Built** |
| GET | `/properties/:propertyId/tenancy-interests?status=` | One property's rows, `pending` by default — this IS the Applicants list | Landlord (owner) | **Built** |

Every response is a `TenancyInterest`: the row's ids/status/timestamps plus a
view that depends on which side the caller is on (`viewerSide`):
- **Renter view** (`viewerSide: 'renter'`): `counterparty.displayName` = the
  landlord's name; `property` = listing details (`title`, `description`,
  `propertyRules`, `addressLine1`, `city`, `postcode`, `bedrooms`, `rentAmount`,
  `currency`), or `null` if the listing was archived after they expressed interest.
- **Landlord view** (`viewerSide: 'landlord'`): `counterparty.displayName` = the
  renter's name; `property` = summary only (`addressLine1`, `city`, `postcode`,
  `bedrooms`, `rentAmount`, `currency`).

No evidence, pillar, trust or compatibility data in either view.

**Declined rows are visible only to the side that declined them** — enforced by RLS,
not just the API. Re-expressing interest on a declined pairing returns the same 409
whichever side declined.

**Request body:** `{ propertyId, renterId? }`. Behavior branches on the
caller's role (`users.role`), not on which fields are present:
- **Renter caller** — `renterId` is ignored even if sent; `renter_id` is always
  taken from the session, never trusted from the body (prevents a renter
  expressing interest on another renter's behalf).
- **Landlord caller** — `renterId` is **required**. Reject with 400 if missing.
  Server validates: the property belongs to this landlord (404 if not), it is
  published (409 if not), and `renterId` is a real renter (400 if not).

This was a real gap in the original spec, not just a style choice — `{ propertyId }`
alone is structurally ambiguous for the landlord case, since one property can have
many interested renters and nothing in that shape says which one. Caught before the
migration was built, which is the right time to catch it.

**Status flips to `matched` automatically** (DB trigger) the moment both
`renter_interested_at` and `landlord_interested_at` are set — not a client action.

### ⚠️ Real open gap this redesign created — not resolved yet

The old `applications` table snapshotted `trust_profile_id` and `match_id` at the
moment of decision specifically so you could always reconstruct exactly what a
landlord saw when they made a call — the same reasoning behind the append-only
trust profile history. **`tenancy_interests` as currently designed has no equivalent
snapshot.** Two real questions, unresolved:

1. Does a formal `applications` step still exist *after* a match (e.g. once matched
   and chatted, the renter formally applies with full documentation before a lease),
   making Tenancy Interests a pre-application discovery layer rather than a
   replacement for applications entirely?
2. If Tenancy Interests is the whole decision flow now, should it carry its own
   snapshot of trust profile / compatibility at the moment either side expresses
   interest — for the same defensibility reasons the original design had?

Don't build past this silently — it's worth resolving before applications-adjacent
work goes further.

---

## Matched (chat placeholder)

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| GET | `/tenancy-interests/me?status=matched` | List matched connections for the current user | Renter or Landlord | **Built** — the status filter on the endpoint above, no separate endpoint |

Real chat (`conversations`/`messages`) is explicitly out of scope right now — the
app should show a "chat coming soon" placeholder for matched rows, not a working
message thread.

---

## Tenancy Outcomes

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| POST | `/applications/:id/outcome` | Record outcome (role inferred from session) | Renter or Landlord | Pending — path depends on resolving the applications-gap question above |
| GET | `/tenancy-outcomes/me` | List own recorded outcomes | Renter or Landlord | Pending |

---

## Explicitly not building yet

- `institution_admin` CRUD/invite endpoints
- Automated Scottish Landlord Register lookup
- Evidence reviewer/admin transition endpoints
- `platform_admin` creation — seed script only, never an HTTP endpoint
- Real chat/messaging — stub placeholder only for now

---

## Suggested build order (updated)

1. `GET /me` — small, unblocks frontend role-based routing immediately
2. Identity verification (renter) — gates evidence
3. Landlord verification — gates property publishing
4. Preferences (both sides) — needed before matching means anything
5. Properties — needed before tenancy interests exist
6. Matching (computed compatibility) — depends on preferences + properties
7. **Tenancy Interests** — depends on matching existing; resolve the applications-gap
   question above before or during this step, not after
8. Trust profile generation — can run in parallel with 3–7
9. Tenancy outcomes + disputes — last, lowest urgency for MVP