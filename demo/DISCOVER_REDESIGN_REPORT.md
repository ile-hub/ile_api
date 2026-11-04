Discover restoration and existing-card redesign — 28 October 2026

Implemented in the existing frontend only. No backend service/configuration restart, schema change, migration, reseed, account/property/connection/message creation, matching change or frontend route was added. The two modified source files are in /Users/martins/ile-app. Pre-existing uncommitted frontend work was preserved; baseline copies for these two files were saved under /private/tmp/leri-discover-edit before editing.

Phase 1: diagnosis and restoration

The isolated API at http://localhost:3001 was healthy (HTTP 200, status/db ok), running as the existing guarded preview process PID 71336. Read-only inspection confirmed leri-phase2-validation-20261014-final, Supabase 127.0.0.1:55321 and PostgreSQL 127.0.0.1:55322/postgres. No preview configuration was lost in the running backend. Jamie and Amina both authenticated with their unchanged existing passwords, and actual /me roles/IDs matched the approved renter/landlord accounts.

The frontend .env.local correctly points to http://localhost:3001 and http://localhost:55321. The older .env still contains original-dev defaults, but no configuration file was changed. The running frontend displayed the correct isolated account identities and isolated profile data; it was not necessary to change endpoints or restart Metro. Metro remained listening on 8081. Sandboxed curl to Metro failed once; host inspection showed the listener, so this was not treated as a packager outage.

The reported complete disappearance was not reproducible against the current API: all expected profiles were returned. The initial captured frontend card was stale: David showed zero homes while the actual API returned three preview homes. Revisiting Discover in Amina’s existing session refreshed the response and showed renter cards. The query hook already refreshes on navigation focus and supports pull-to-refresh, but the screen did not explicitly reload when a still-focused app resumed after backend/data changes. Evidence supports stale mounted client state rather than missing accounts, a matching defect or a lost backend preview flag. The exact historical event that produced the reported disappearance cannot be proved retroactively from these checks. No invalid current session or incorrect API role was found.

Discovery now also refreshes when the focused screen receives AppState active, with listener cleanup; a visible Refresh people action uses the existing query.refresh path. Query keys still include user ID, role and mode; existing stale-response/pagination protections remain intact. API-provided discovery arrays are rendered directly instead of applying a redundant client role filter. Opposite-role eligibility remains enforced by the unchanged backend. No six-account list or new eligibility filter was hardcoded.

Actual API results

| Viewer | Role | Explore All | Suggested | People in both results |
|---|---|---:|---:|---|
| Jamie | renter | 3 | 3 | Amina, Sarah, David |
| Amina | landlord | 3 | 3 | Jamie, Lewis, Priya |

Jamie’s /profiles/:aminaId response contains exactly Dennistoun Corner Flat, Merchant City Living and Shawlands flat. Each is status=draft and listingStatus=demo_preview. All three existing image download/fetch requests returned 200. Public property counts from the API are Amina 3, David 3 and Sarah 1; cards do not substitute self-declared portfolio size for that count.

Phase 2: existing cards

- Existing Card component is locally styled white with a quiet border and generous spacing; no global card theme change.
- Larger existing ProfilePortrait presentation, name, role and area. Existing fictional demo-portrait resolution and production behavior are untouched.
- Introductions are readable complete text, with no three-line mid-sentence ellipsis. Renter budget/move date appear as quiet facts only where supplied; no missing preference is fabricated.
- Existing primary View Profile navigation retained. Compatibility reasons are exactly the API strings, shown only when supplied. Explore All remains independent and receives no inferred matching reason.
- Landlord home count and a compact actual property image come only from properties supplied by the API. Preview homes explicitly say illustrative demo / Not published; no available/published claim is derived from draft data.
- The card’s yellow mock-verification banner and green chip stack are replaced by one understated “Illustrative demo profile · Verification not completed” disclosure. It opens the same existing profile for details. Verification details elsewhere in the existing profile screen are preserved; no successful verification is implied.
- The existing PropertyPhoto renderer gained optional compact presentation for the card. Its default detail/gallery rendering, captions, API access and retry/error behavior remain unchanged.
- No doodles, conversation edits, new screens or duplicate routes.

Changed frontend source files

1. src/screens/discover/DiscoverScreen.tsx — card layout, direct API list rendering, focused-resume reload and manual refresh action.
2. src/screens/discover/PropertyDetailScreen.tsx — optional compact prop on the existing PropertyPhoto renderer; default detail behavior unchanged.

No shared API contract/type file, auth module, environment file, matching code, route definition or backend source was modified.

Tests and visual verification

- npm run typecheck: passed (including noUnusedLocals/noUnusedParameters).
- npm run lint: passed, zero warnings. An initial render-time ref assignment in the new resume effect was corrected to use the stable reload callback as an effect dependency; the final lint pass is clean.
- node --test scripts/*.test.mjs: 35 existing regression tests passed. No live-fixture-creating integration script was run.
- 8 additional focused component/state checks passed from the ignored validation harness. Covers API-array preservation, portraits/full introduction/disclosure, actual home count versus portfolio count, no invented preview homes, exact compatibility reasons, existing person routes, focused resume refresh and request-error/manual-refresh behavior. The temporary harness is diagnostic evidence, not a newly added frontend test screen.
- Real API health, Jamie/Amina roles, both discovery modes and Amina’s three existing photo downloads: passed.
- Amina’s authenticated simulator cards: before/after captured; renter portraits, names, human text, budget, suggestion reasons and the new disclosure render. Explore All presentation omits suggestion reasons.
- User manually signed in as Jamie after automated keyboard/Paste checks were declined. His actual authenticated simulator cards were captured with Amina, Sarah and David, including illustrative images/counts and suggestion reasons. Explore All was selected and captured separately.
- Jamie’s View Profile action was verified to open Amina’s existing public profile; screenshot captured.
- LIMITATION: the final simulator scroll through all three homes/photos within Amina’s profile was declined. That specific visual gallery walkthrough is NOT marked passed. The three homes and all three photo fetches are verified at the real API, and the card’s Amina image was visually rendered. No attempt was made to bypass the declined action.

Before/after screenshots (app only; ignored local evidence)

- demo/discover-validation.local/before-amina-discover.png — original pale-green renter card.
- demo/discover-validation.local/after-amina-explore-card.png — complete redesigned renter card, no suggestion reasons in Explore.
- demo/discover-validation.local/after-amina-suggested-card.png — API compatibility reasons and quieter disclosure.
- demo/discover-validation.local/after-jamie-discover.png — prominent Amina portrait/name/role/area.
- demo/discover-validation.local/after-jamie-suggested-card.png — Amina’s actual preview home/photo, count and compatibility reasons.
- demo/discover-validation.local/after-jamie-explore-card.png — the same card in broad Explore All, without reasons.
- demo/discover-validation.local/jamie-opened-amina-profile.png — successful existing profile navigation.

The original desktop-wide capture is not included in report artifacts because it contained the IDE; only app-only screenshots are used. No passwords or tokens appear in the report or curated evidence. Existing credential files remain ignored. Nothing was committed.

Final read-only dataset counts: 6 accounts, 7 properties, 7 unpublished drafts, 7 active photos, 9 connections and 6 messages. No data writes were performed by this task except normal Auth session sign-in/sign-out activity. No publication/verification/compliance value changed.

Stopped after frontend changes and the verification described above. The isolated API and Metro were left running; Jamie remains signed in. Remaining manual verification is the declined full profile-gallery scroll. API/portrait availability and image hosting were not changed.
