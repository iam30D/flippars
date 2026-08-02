import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { loadLocalEnvironment } from "../environment.js";
import {
  DEFAULT_RETENTION_BATCH_SIZE,
  DEFAULT_RETENTION_MAX_ROWS_PER_TABLE,
  runOperationalRetention,
} from "./retention.js";

interface RetentionCliOptions {
  readonly batchSize: number;
  readonly maxRowsPerTable: number;
  readonly help: boolean;
}

export function parseRetentionArguments(
  arguments_: readonly string[],
): RetentionCliOptions {
  let batchSize = DEFAULT_RETENTION_BATCH_SIZE;
  let maxRowsPerTable = DEFAULT_RETENTION_MAX_ROWS_PER_TABLE;
  let help = false;

  for (const argument of arguments_) {
    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument.startsWith("--batch-size=")) {
      batchSize = strictInteger(argument.slice("--batch-size=".length), "--batch-size");
    } else if (argument.startsWith("--max-rows-per-table=")) {
      maxRowsPerTable = strictInteger(
        argument.slice("--max-rows-per-table=".length),
        "--max-rows-per-table",
      );
    } else {
      throw new Error(`Unknown retention argument: ${argument}`);
    }
  }

  return { batchSize, maxRowsPerTable, help };
}

async function main(): Promise<void> {
  const options = parseRetentionArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: retention-cli [--batch-size=1000] [--max-rows-per-table=100000]\n",
    );
    return;
  }

  loadLocalEnvironment();
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required for retention");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    ...(config.databaseSsl
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(config.databaseCaCert ? { ca: config.databaseCaCert } : {}),
          },
        }
      : {}),
  });

  try {
    const result = await runOperationalRetention(
      {
        query: async (statement, parameters) =>
          await pool.query(statement, [...parameters]),
      },
      {
        batchSize: options.batchSize,
        maxRowsPerTable: options.maxRowsPerTable,
      },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

function strictInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`${name} is outside the safe range`);
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Retention failed"}\n`,
    );
    process.exitCode = 1;
  });
}
