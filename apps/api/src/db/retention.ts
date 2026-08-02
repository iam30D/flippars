export const DEFAULT_RETENTION_BATCH_SIZE = 1_000;
export const DEFAULT_RETENTION_MAX_ROWS_PER_TABLE = 100_000;

const MAX_RETENTION_BATCH_SIZE = 5_000;
const MAX_RETENTION_ROWS_PER_TABLE = 1_000_000;

export interface RetentionDatabase {
  query(
    statement: string,
    parameters: readonly unknown[],
  ): Promise<{ rowCount: number | null }>;
}

export interface OperationalRetentionOptions {
  readonly cutoff?: Date;
  readonly batchSize?: number;
  readonly maxRowsPerTable?: number;
}

export interface TableRetentionResult {
  readonly deleted: number;
  /** True means this run reached its configured bound; more expired rows may remain. */
  readonly capped: boolean;
}

export interface OperationalRetentionResult {
  readonly cutoff: string;
  readonly batchSize: number;
  readonly maxRowsPerTable: number;
  readonly marketObservations: TableRetentionResult;
  readonly notificationDeliveries: TableRetentionResult;
}

const DELETE_MARKET_OBSERVATIONS = `
  WITH expired AS (
    SELECT id
    FROM market_observations
    WHERE retain_until <= $1::timestamptz
    ORDER BY retain_until, id
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM market_observations AS target
  USING expired
  WHERE target.id = expired.id
`;

const DELETE_NOTIFICATION_DELIVERIES = `
  WITH expired AS (
    SELECT device_id, signal_id
    FROM notification_deliveries
    WHERE retain_until <= $1::timestamptz
    ORDER BY retain_until, device_id, signal_id
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM notification_deliveries AS target
  USING expired
  WHERE target.device_id = expired.device_id
    AND target.signal_id = expired.signal_id
`;

export async function runOperationalRetention(
  database: RetentionDatabase,
  options: OperationalRetentionOptions = {},
): Promise<OperationalRetentionResult> {
  const cutoff = options.cutoff ?? new Date();
  if (!Number.isFinite(cutoff.getTime()))
    throw new Error("Retention cutoff must be valid");

  const batchSize = boundedPositiveInteger(
    options.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE,
    "batchSize",
    MAX_RETENTION_BATCH_SIZE,
  );
  const maxRowsPerTable = boundedPositiveInteger(
    options.maxRowsPerTable ?? DEFAULT_RETENTION_MAX_ROWS_PER_TABLE,
    "maxRowsPerTable",
    MAX_RETENTION_ROWS_PER_TABLE,
  );
  const cutoffIso = cutoff.toISOString();

  const marketObservations = await purgeInBatches(
    database,
    DELETE_MARKET_OBSERVATIONS,
    cutoffIso,
    batchSize,
    maxRowsPerTable,
  );
  const notificationDeliveries = await purgeInBatches(
    database,
    DELETE_NOTIFICATION_DELIVERIES,
    cutoffIso,
    batchSize,
    maxRowsPerTable,
  );

  return {
    cutoff: cutoffIso,
    batchSize,
    maxRowsPerTable,
    marketObservations,
    notificationDeliveries,
  };
}

async function purgeInBatches(
  database: RetentionDatabase,
  statement: string,
  cutoff: string,
  batchSize: number,
  maximum: number,
): Promise<TableRetentionResult> {
  let deleted = 0;
  while (deleted < maximum) {
    const limit = Math.min(batchSize, maximum - deleted);
    const result = await database.query(statement, [cutoff, limit]);
    const count = result.rowCount ?? 0;
    if (!Number.isInteger(count) || count < 0 || count > limit) {
      throw new Error("Retention query returned an invalid deletion count");
    }
    deleted += count;
    if (count < limit) break;
  }
  return { deleted, capped: deleted === maximum };
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}
