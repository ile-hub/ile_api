Synthetic-profile cleanup — 28 October 2026

Completed only in isolated leri-phase2-validation-20261014-final, Supabase 127.0.0.1:55321 and PostgreSQL 127.0.0.1:55322/postgres. Docker identities and target were verified. Original development and production were not accessed.

Removed 193 unwanted synthetic accounts from both public.users and Supabase Auth, leaving exactly Amina, David, Sarah, Jamie, Priya and Lewis. All removed accounts used reserved example.test addresses; they included E2E, discovery, migration-sentinel, phase and frontend test identities. Deletion was constrained to the inventoried UUIDs, excluding the exact six approved showcase IDs.

Dependent test data was deleted in foreign-key order in a single transaction: 258 old properties, 32 old connections (with their messages cascading), 100 old tenancy interests, 47 evidence items, 13 evidence-document metadata records, 21 photo metadata records, 14 landlord preference rows, 18 renter preference rows, and old test acceptance/consent rows. Associated unwanted renter/landlord profiles and Auth sessions were removed through existing cascades. Shared legal document versions, evidence catalogue, schema, RLS policies and migration history were retained.

Before commit, complete protected-row snapshots were identical: six showcase user/profile/password records, seven draft properties, seven illustrative property-photo metadata records, nine connections and six messages, plus protected preferences/evidence/legal history. The six-account/seven-draft preview ownership validation still passed. No verification, EPC, registration, HMO or publication values changed.

After commit, all six original passwords successfully signed in to local Supabase. The running API returned HTTP 200 for every retained identity, discovery and conversation read. Explore All returns exactly three opposite-role people for each account, with no extra cursor. Each person still has three connections and the same two-message accepted conversation.

A private recovery data backup was saved before deletion (public/auth/storage metadata schemas; mode 0600; gitignored):

/Users/martins/ile-api/demo/before-synthetic-cleanup-1793191291860.sql.local

The backup contains sensitive Auth data and must remain local. Storage object bytes were not deleted or made public; old private test files may remain in their existing private buckets without profile/media metadata. No bucket or Storage policy was changed. The retained seven property photos are unaffected.

Detailed cleanup and API evidence are in gitignored mode-0600 synthetic-cleanup.local and cleanup-api-verification.local. Existing credentials remain in showcase.credentials.local; old removed-account credential files were not rewritten and no longer authenticate to this isolated environment. No secrets are included in this report. No code or database schema changes, resets, migrations or new fixtures were performed.

The removed migration-sentinel identities were synthetic test profiles explicitly included in this cleanup. Do not treat older sentinel-based validation reports as current evidence after this intentional deletion. Re-running broad E2E suites may create more synthetic profiles; this task did not rerun suites that create users.
