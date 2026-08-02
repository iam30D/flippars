import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseRetentionArguments } from "../src/db/retention-cli.js";
import {
  runOperationalRetention,
  type RetentionDatabase,
} from "../src/db/retention.js";

interface RecordedQuery {
  readonly statement: string;
  readonly parameters: readonly unknown[];
}

class ScriptedDatabase implements RetentionDatabase {
  readonly queries: RecordedQuery[] = [];

  constructor(private readonly counts: number[]) {}

  query(
    statement: string,
    parameters: readonly unknown[],
  ): Promise<{ rowCount: number }> {
    this.queries.push({ statement, parameters });
    return Promise.resolve({ rowCount: this.counts.shift() ?? 0 });
  }
}

void describe("bounded operational retention", () => {
  void test("deletes only expired operational rows in bounded batches", async () => {
    const database = new ScriptedDatabase([3, 2, 1]);
    const result = await runOperationalRetention(database, {
      cutoff: new Date("2026-08-01T00:00:00.000Z"),
      batchSize: 3,
      maxRowsPerTable: 5,
    });

    assert.deepEqual(result.marketObservations, { deleted: 5, capped: true });
    assert.deepEqual(result.notificationDeliveries, { deleted: 1, capped: false });
    assert.deepEqual(
      database.queries.map((query) => query.parameters),
      [
        ["2026-08-01T00:00:00.000Z", 3],
        ["2026-08-01T00:00:00.000Z", 2],
        ["2026-08-01T00:00:00.000Z", 3],
      ],
    );
    assert.match(
      database.queries[0]?.statement ?? "",
      /DELETE FROM market_observations/,
    );
    assert.match(
      database.queries[2]?.statement ?? "",
      /DELETE FROM notification_deliveries/,
    );
    for (const query of database.queries) {
      assert.match(query.statement, /retain_until <= \$1::timestamptz/);
      assert.doesNotMatch(
        query.statement,
        /\b(?:signals|audit_events|model_registry)\b/,
      );
    }
  });

  void test("stops each table as soon as a batch is not full", async () => {
    const database = new ScriptedDatabase([2, 0]);
    const result = await runOperationalRetention(database, {
      cutoff: new Date("2026-08-01T00:00:00.000Z"),
      batchSize: 3,
      maxRowsPerTable: 9,
    });

    assert.equal(database.queries.length, 2);
    assert.deepEqual(result.marketObservations, { deleted: 2, capped: false });
    assert.deepEqual(result.notificationDeliveries, { deleted: 0, capped: false });
  });

  void test("rejects invalid or unexpectedly large bounds", async () => {
    const database = new ScriptedDatabase([]);
    await assert.rejects(
      runOperationalRetention(database, { batchSize: 0 }),
      /batchSize must be an integer/,
    );
    await assert.rejects(
      runOperationalRetention(database, { maxRowsPerTable: 1_000_001 }),
      /maxRowsPerTable must be an integer/,
    );
    await assert.rejects(
      runOperationalRetention(database, { cutoff: new Date("invalid") }),
      /cutoff must be valid/,
    );
  });

  void test("rejects a database count larger than the requested batch", async () => {
    const database = new ScriptedDatabase([4]);
    await assert.rejects(
      runOperationalRetention(database, { batchSize: 3, maxRowsPerTable: 9 }),
      /invalid deletion count/,
    );
  });
});

void describe("retention command arguments", () => {
  void test("parses explicit bounds and rejects unknown arguments", () => {
    assert.deepEqual(
      parseRetentionArguments(["--batch-size=250", "--max-rows-per-table=5000"]),
      { batchSize: 250, maxRowsPerTable: 5_000, help: false },
    );
    assert.throws(() => parseRetentionArguments(["--cutoff=tomorrow"]), /Unknown/);
    assert.throws(
      () => parseRetentionArguments(["--batch-size=-1"]),
      /positive integer/,
    );
  });
});
