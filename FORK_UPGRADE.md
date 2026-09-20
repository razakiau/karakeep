# Fork upgrade notes

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

| Approach | Outcome |
| --- | --- |
| Run migrations as-is | Fails with `duplicate column name`, whole batch rolls back |
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
