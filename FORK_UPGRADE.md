# Fork upgrade notes

## How this fork's branches work

- `main` is what runs in the homelab: upstream at a release tag plus the fork
  commits. The image built from it is pinned by digest in zhomelab.
- Each fix also keeps its own branch (`fix/transcript-without-video-download`,
  `zack/zac-317-...`). Those branches are the material for an upstream PR
  later; don't delete them.
- A new upstream release: branch from the upstream tag, cherry-pick the fork
  commits from `main`, build, deploy, then move `main` to that branch. Tag the
  old `main` first (`fork-main-v<old>`) and push with `--force-with-lease`.
- Tags `fork-main-v0.33.2` and `fork-0.34.1-cst2` mark the old and the current
  deployed line.

## Upgrading to the v0.34 rebase (content source tracking v4)

Upstream v0.34 took migration number 0094 for `0094_migrate_to_better_auth`,
stamped _earlier_ (1785711744217) than the fork's `0094_add_content_source`
(1789922999922). The fork's migration is now `0095_add_content_source`.

A database that ran the v0.33 fork therefore holds a contentSource row whose
stamp is newer than upstream's 0094: drizzle's watermark would skip the
better-auth migration and then fail 0095 with `duplicate column name`. This is
the same shape as the 0081 case below, and the same reconciliation fixes it.

**`migrate.ts` now runs the reconciliation itself**, before and after drizzle's
`migrate()`, so the image's startup migration handles both cases. Both steps
are no-ops on a fresh or already-reconciled database. Back up `db.db` first
anyway.

After the upgrade, expect `__drizzle_migrations` to hold 96 rows (95 before),
the newest stamped with 0095's `when`, and the `contentSource` distribution to
match what it was before.

## Upgrading a database that ran the old fork `0081_add_content_source`

**Applies to:** any deployment that ran this fork before it was rebased onto
upstream v0.33.2. A fresh install needs none of this.

**Symptom if skipped:** the app fails on startup with

```
SqliteError: duplicate column name: contentSource
```

and the migration batch rolls back, leaving the app crash-looping.

### Why

This fork added `bookmarkLinks.contentSource` in a local migration numbered
0081, which shadowed upstream's real `0081_add_archived_to_import_staging_bookmarks`.
Upstream has since added the same column as 0094. An affected database is
therefore in an inconsistent state:

- the `contentSource` column already exists
- `__drizzle_migrations` holds one row stamped with the old 0081 time, whose
  hash is identical to 0094's (the SQL is byte-identical)
- upstream migrations 0081..0093 never ran

Drizzle picks what to run from a single `MAX(created_at)` watermark and applies
everything newer inside one transaction (see
`drizzle-orm/sqlite-core/dialect.js`). That leaves two failure modes:

| Approach                    | Outcome                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run migrations as-is        | Fails with `duplicate column name`, whole batch rolls back                                                                                                                    |
| Restamp the stale row first | **Silently skips upstream 0081..0093.** The schema ends up missing columns the new code selects (e.g. `readerViewStatus`), so it fails later at runtime instead of at startup |

The second is the more dangerous one: migrations report success.

SQLite has no conditional `ALTER TABLE`, so 0094 cannot be made idempotent. The
reconciliation has to happen around the migration rather than inside it.

### Procedure

Back up the database first.

```bash
# 1. Preserve non-default values, remove the shadowed row, drop the column
pnpm --filter @karakeep/db run reconcile:fork-content-source

# 2. Run migrations normally — upstream 0081..0093 and 0094 all apply
pnpm --filter @karakeep/db run migrate

# 3. Restore the preserved values
pnpm --filter @karakeep/db run reconcile:fork-content-source --restore
```

Each step is idempotent and a no-op unless it finds the state it handles, so a
re-run or a retry after a partial failure is safe. Step 3 refuses to run if the
column is missing, rather than silently discarding the saved values.

Requires SQLite >= 3.35 for `DROP COLUMN`.

### Verifying

```sql
SELECT COUNT(*) FROM __drizzle_migrations;                 -- expect 95
SELECT contentSource, COUNT(*) FROM bookmarkLinks GROUP BY contentSource;
PRAGMA integrity_check;                                    -- expect ok
```

The `contentSource` distribution should match what it was before the upgrade.
