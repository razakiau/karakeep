/**
 * One-time reconciliation for forks that shipped `contentSource` as a local
 * migration before it existed upstream.
 *
 * ## The problem
 *
 * This fork added `bookmarkLinks.contentSource` in a local migration numbered
 * 0081, which shadowed upstream's real 0081. Upstream's migration set has since
 * grown past it, and the same column is now added by 0094. On an affected
 * database the recorded state is therefore inconsistent:
 *
 *   - the column already exists
 *   - `__drizzle_migrations` holds one row stamped with the *old* 0081 time,
 *     whose hash is identical to 0094's (the SQL is byte-identical)
 *   - upstream 0081..0093 never ran
 *
 * Drizzle decides what to run from a single `MAX(created_at)` watermark and
 * applies everything newer inside one transaction
 * (see drizzle-orm/sqlite-core/dialect.js). That leaves two bad outcomes:
 *
 *   - run migrations as-is  -> 0094 fails with "duplicate column name", the
 *                              whole batch rolls back, the app crash-loops
 *   - restamp the row first -> the watermark jumps past upstream 0081..0093 and
 *                              they are silently SKIPPED, leaving the schema
 *                              missing columns the new code selects
 *
 * SQLite has no conditional `ALTER TABLE`, so 0094 cannot be made idempotent.
 * The reconciliation has to happen before migrations run.
 *
 * ## What this does
 *
 * Preserves the non-default `contentSource` values, removes the shadowed
 * migration row, and drops the column so that upstream 0081..0093 and 0094 all
 * apply as a normal batch. Values are restored afterwards.
 *
 * Safe to run on any database: it is idempotent and a no-op unless it finds the
 * exact inconsistent state described above.
 *
 * Usage:
 *   pnpm --filter @karakeep/db run reconcile:fork-content-source        # step 1
 *   pnpm --filter @karakeep/db run migrate
 *   pnpm --filter @karakeep/db run reconcile:fork-content-source --restore
 *
 * Requires SQLite >= 3.35 for `DROP COLUMN`.
 */
import "dotenv/config";

import Database from "better-sqlite3";

import dbConfig from "./drizzle.config";

/** sha256 of 0094_add_content_source.sql, identical to the fork's old 0081. */
const SHADOWED_MIGRATION_HASH =
  "74987bf0a452a21efcf831733bb7521780a26edda055f6dedd5ec4ec2d1f50cf";

/**
 * `when` of 0094 in the drizzle journal. A row carrying the hash above but an
 * *earlier* timestamp is the fork's shadowed 0081; at or after this value it is
 * the legitimate 0094 and must be left alone.
 */
const CONTENT_SOURCE_MIGRATION_MILLIS = 1789922999922;

const BACKUP_TABLE = "_karakeep_content_source_backup";

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name);
}

function columnExists(
  db: Database.Database,
  table: string,
  column: string,
): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column) !== undefined
  );
}

function prepare(db: Database.Database): void {
  if (!tableExists(db, "__drizzle_migrations")) {
    console.log("[reconcile] No migrations table yet; nothing to do.");
    return;
  }

  const shadowed = db
    .prepare(`SELECT created_at FROM __drizzle_migrations WHERE hash = ?`)
    .get(SHADOWED_MIGRATION_HASH) as { created_at: number } | undefined;

  if (!shadowed) {
    console.log(
      "[reconcile] Shadowed migration row not present; nothing to do.",
    );
    return;
  }

  // Once migrations have run, this same hash is present again — legitimately,
  // stamped with 0094's own time. Only the *stale* stamp needs reconciling;
  // treating the legitimate one as stale would drop a live column.
  if (shadowed.created_at >= CONTENT_SOURCE_MIGRATION_MILLIS) {
    console.log(
      "[reconcile] Already reconciled (migration recorded at its own " +
        "timestamp); nothing to do.",
    );
    return;
  }

  if (!columnExists(db, "bookmarkLinks", "contentSource")) {
    console.log(
      "[reconcile] contentSource column already absent; nothing to do.",
    );
    return;
  }

  db.exec("BEGIN");
  try {
    db.exec(`DROP TABLE IF EXISTS ${BACKUP_TABLE}`);
    db.exec(
      `CREATE TABLE ${BACKUP_TABLE} AS
         SELECT id, contentSource FROM bookmarkLinks
          WHERE contentSource IS NOT NULL AND contentSource <> 'crawled'`,
    );
    const backedUp = (
      db.prepare(`SELECT COUNT(*) AS n FROM ${BACKUP_TABLE}`).get() as {
        n: number;
      }
    ).n;

    db.prepare(`DELETE FROM __drizzle_migrations WHERE hash = ?`).run(
      SHADOWED_MIGRATION_HASH,
    );
    db.exec(`ALTER TABLE bookmarkLinks DROP COLUMN contentSource`);
    db.exec("COMMIT");

    console.log(
      `[reconcile] Prepared: backed up ${backedUp} non-default value(s), ` +
        `removed the shadowed migration row, dropped the column.`,
    );
    console.log("[reconcile] Now run migrations, then re-run with --restore.");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function restore(db: Database.Database): void {
  if (!tableExists(db, BACKUP_TABLE)) {
    console.log("[reconcile] No backup table; nothing to restore.");
    return;
  }

  if (!columnExists(db, "bookmarkLinks", "contentSource")) {
    throw new Error(
      "[reconcile] contentSource column is missing — migrations have not run " +
        "yet. Run them before restoring, or the saved values will be lost.",
    );
  }

  db.exec("BEGIN");
  try {
    const res = db
      .prepare(
        `UPDATE bookmarkLinks
            SET contentSource = (
              SELECT b.contentSource FROM ${BACKUP_TABLE} b
               WHERE b.id = bookmarkLinks.id)
          WHERE id IN (SELECT id FROM ${BACKUP_TABLE})`,
      )
      .run();
    db.exec(`DROP TABLE ${BACKUP_TABLE}`);
    db.exec("COMMIT");
    console.log(`[reconcile] Restored ${res.changes} value(s).`);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

const db = new Database(dbConfig.dbCredentials.url);
try {
  if (process.argv.includes("--restore")) {
    restore(db);
  } else {
    prepare(db);
  }
} finally {
  db.close();
}
