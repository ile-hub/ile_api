#!/usr/bin/env sh
# Pre-commit check: if this commit stages a supabase/migrations/*.sql file
# whose content alters RLS policies, roles, or trigger functions, db/schema.sql
# must be staged in the same commit.
#
# This does NOT check that db/schema.sql was updated correctly -- only that
# it was touched at all. The point is to force whoever wrote the migration
# to also be the one who updates schema.sql's reasoning comments, while the
# context for why is still in their head, not to validate that content.
# See db/schema.sql's own header and CLAUDE.md: it's meant to stay the
# current revised draft, not just a historical snapshot migrations drift
# away from.
set -e

staged_files=$(git diff --cached --name-only --diff-filter=ACMR)

migration_files=$(printf '%s\n' "$staged_files" | grep -E '^supabase/migrations/.*\.sql$' || true)

if [ -z "$migration_files" ]; then
  exit 0
fi

schema_touched=$(printf '%s\n' "$staged_files" | grep -Fx 'db/schema.sql' || true)

# RLS policies | roles/grants | trigger functions
pattern='CREATE POLICY|ALTER POLICY|DROP POLICY|ENABLE ROW LEVEL SECURITY|DISABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY|CREATE ROLE|ALTER ROLE|DROP ROLE|GRANT |REVOKE |CREATE( OR REPLACE)? FUNCTION|DROP FUNCTION|CREATE TRIGGER|DROP TRIGGER|ALTER TRIGGER'

flagged=""
for f in $migration_files; do
  # git show ':path' reads the STAGED (index) content, i.e. what this
  # commit will actually contain -- not the working-tree file, which may
  # differ if there are unstaged edits on top.
  if git show ":$f" 2>/dev/null | grep -Eiq "$pattern"; then
    flagged="$flagged $f"
  fi
done

if [ -n "$flagged" ] && [ -z "$schema_touched" ]; then
  echo "----------------------------------------------------------------------" >&2
  echo "pre-commit: migration(s) altering RLS policies, roles, or trigger"     >&2
  echo "functions are staged, but db/schema.sql is not staged in the same"    >&2
  echo "commit:"                                                              >&2
  for f in $flagged; do
    echo "  - $f"                                                             >&2
  done
  echo                                                                        >&2
  echo "db/schema.sql is this repo's readable source-of-truth draft (see"     >&2
  echo "CLAUDE.md). Update it to reflect this change and 'git add' it, or"    >&2
  echo "if it genuinely doesn't apply here, commit with --no-verify."         >&2
  echo "----------------------------------------------------------------------" >&2
  exit 1
fi

exit 0
