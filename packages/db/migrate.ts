// Must load before @karakeep/shared/config, which parses process.env at import time.
import "dotenv/config";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import serverConfig from "@karakeep/shared/config";

import { db } from "./drizzle";
import {
  reconcileBeforeMigrate,
  restoreAfterMigrate,
} from "./reconcileForkContentSource";

if (serverConfig.degradedMode) {
  console.log("Skipping database migrations in degraded mode");
} else {
  // Fork: repair a stale contentSource migration stamp around the batch
  // (FORK_UPGRADE.md). Both steps are no-ops on unaffected databases.
  reconcileBeforeMigrate();
  migrate(db, { migrationsFolder: "./drizzle" });
  restoreAfterMigrate();
}
