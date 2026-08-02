import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { loadLocalEnvironment } from "../environment.js";

export async function runMigrations(
  databaseUrl: string,
  ssl = false,
  caCert?: string,
): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: ssl
      ? {
          rejectUnauthorized: true,
          ...(caCert ? { ca: caCert } : {}),
        }
      : undefined,
  });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [7_594_291]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const here = dirname(fileURLToPath(import.meta.url));
    const directory = join(here, "migrations");
    const files = (await readdir(directory))
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort();
    for (const file of files) {
      const version = file.split("_")[0];
      if (!version) continue;
      const existing = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [version],
      );
      if (existing.rowCount) continue;
      const sql = await readFile(join(directory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [
          version,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [7_594_291])
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadLocalEnvironment();
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required to migrate");
  await runMigrations(config.databaseUrl, config.databaseSsl, config.databaseCaCert);
  process.stdout.write("Database migrations complete.\n");
}
