# Ilé API — Endpoint List

Organized by domain, matching `schema.sql` and the renter/landlord screen breakdowns.
**Status column is honest, not aspirational** — most of this is designed, not built.
Only Evidence is actually implemented and tested so far.

Scope excluded deliberately (per earlier decisions): `institution_admin` endpoints,
automated Scottish Landlord Register lookups, evidence reviewer/admin endpoints —
all pending real decisions, not oversights.

---

## Auth & Session

Signup/login themselves are NOT backend endpoints — handled directly by the
Supabase client SDK from `ile-app`, with the `handle_new_user()` Postgres trigger
doing atomic profile creation. The backend only needs to answer "who is this."

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| GET | `/me` | Current user: id, email, role, profile summary | Any authenticated | Pending |

---

## Identity Verification (renters only)

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| POST | `/identity-verifications` | Initiate identity + right-to-rent check (starts Yoti flow) | Renter | Pending |
| GET | `/identity-verifications/me` | Check own verification status | Renter | Pending |
| POST | `/identity-verifications/webhook` | Yoti callback with verification result | None (signature-verified) | Pending |

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

## Evidence (renters only) — the one domain actually built

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| POST | `/evidence` | Submit an evidence item | Renter | **Built** |
| GET | `/evidence` | List own evidence items | Renter | **Built** |
| GET | `/evidence/:id` | Get one evidence item | Renter | **Built** |
| POST | `/evidence/:id/withdraw` | Withdraw evidence (only legal `submitted→withdrawn` transition) | Renter | **Built** |

No generic `PATCH /evidence/:id` exists — by design, there is no client-facing path
to `verified`. Reviewer-side endpoints (`verified`/`rejected` transitions) are
intentionally not built — pending a real reviewer-role decision, same reasoning as
`trust_engine_service`.

---

## Trust Profile (renters only, read-mostly)

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| GET | `/trust-profile/me` | Current trust profile + pillar summaries | Renter | Pending — trust engine doesn't exist yet |
| GET | `/trust-profile/me/history` | Past (superseded) profile generations | Renter | Pending |

Profile *generation* is not a client-triggered action — it should run as an internal
service process (via the planned `trust_engine_service` role) whenever relevant
evidence changes, not via a public endpoint a client calls directly.

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
| POST | `/properties` | Create a property (draft) | Landlord | Pending |
| GET | `/properties/me` | List own properties | Landlord | Pending |
| GET | `/properties/:id` | Get one property | Landlord (owner) or any renter (if listed) | Pending |
| PATCH | `/properties/:id` | Update property details | Landlord (owner) | Pending |
| POST | `/properties/:id/publish` | Publish a draft listing | Landlord (owner) | Pending — **must check landlord verification status first**, this is where that gate actually lives |
| DELETE | `/properties/:id` | Archive a property | Landlord (owner) | Pending |
| GET | `/properties/browse` | Renter-facing browse/search | Renter | Pending |

---

## Matching

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| GET | `/matches/me` | Renter's current computed matches | Renter | Pending |
| GET | `/properties/:id/matches` | Landlord's view of compatible renters for a property (pre-application) | Landlord (owner) | Pending — decide if this exists separately from Applicants, or only surfaces post-application |

Match computation, like trust profile generation, is likely an internal recompute
triggered by preference changes — not a client-called "compute now" endpoint.

---

## Applications

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| POST | `/applications` | Apply to a property (snapshots trust profile + match) | Renter | Pending |
| GET | `/applications/me` | List own applications | Renter | Pending |
| GET | `/applications/:id` | Get one application | Renter (own) or Landlord (property owner) | Pending |
| POST | `/applications/:id/withdraw` | Withdraw an application | Renter | Pending |
| GET | `/properties/:id/applications` | List applicants for a property — trust + compatibility together | Landlord (owner) | Pending |
| PATCH | `/applications/:id/status` | Shortlist / accept / reject | Landlord (owner) | Pending |

---

## Tenancy Outcomes

| Method | Path | Purpose | Role | Status |
|---|---|---|---|---|
| POST | `/applications/:id/outcome` | Record outcome (role inferred from session, not client-supplied) | Renter or Landlord | Pending |
| GET | `/tenancy-outcomes/me` | List own recorded outcomes | Renter or Landlord | Pending |

---

## Explicitly not building yet

- `institution_admin` CRUD/invite endpoints — no schema decision made on how an admin links to an institution
- Automated Scottish Landlord Register lookup — manual entry only for MVP
- Evidence reviewer/admin transition endpoints — no reviewer role designed yet
- `platform_admin` creation — seed script only, never an HTTP endpoint

---

## Suggested build order (matches natural dependency chain)

1. `GET /me` — small, unblocks frontend role-based routing immediately
2. Identity verification (renter) — gates everything evidence-related
3. Landlord verification — gates property publishing
4. Preferences (both sides) — needed before matching means anything
5. Properties — needed before applications exist
6. Matching — depends on preferences + properties both existing
7. Applications — depends on matching + trust profile both existing
8. Trust profile generation — can actually be built in parallel with 3–6, since evidence submission already works
9. Tenancy outcomes + disputes — last, lowest urgency for MVP