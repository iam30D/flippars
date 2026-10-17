import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readBoundedJsonl } from "../src/research/bounded-jsonl.js";

async function fixture(bytes: Buffer, check: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "flippars-jsonl-"));
  try {
    const path = join(directory, "events.jsonl");
    await writeFile(path, bytes);
    await check(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("streaming reader preserves split UTF-8 records and hashes exact bytes", async () => {
  const lines = ["x".repeat(65_535) + "€", '{"ok":true}'];
  const bytes = Buffer.from(lines.join("\n") + "\n");
  await fixture(bytes, async (path) => {
    const actual: string[] = [];
    const evidence = await readBoundedJsonl(path, bytes.length, (line) =>
      actual.push(line),
    );
    assert.deepEqual(actual, lines);
    assert.deepEqual(evidence, {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });
});

test("streaming reader rejects truncation, malformed UTF-8, empty and oversized lines", async () => {
  for (const bytes of [
    Buffer.from("unfinished"),
    Buffer.from([255, 10]),
    Buffer.from("\n"),
    Buffer.from("x".repeat(524_289) + "\n"),
  ]) {
    await fixture(bytes, async (path) => {
      await assert.rejects(readBoundedJsonl(path, bytes.length, () => {}));
    });
  }
});

test("streaming reader closes on byte limits and consumer failures", async () => {
  await fixture(Buffer.from("one\ntwo\n"), async (path) => {
    await assert.rejects(readBoundedJsonl(path, 3, () => {}));
    await assert.rejects(
      readBoundedJsonl(path, 8, () => {
        throw new Error("invalid record");
      }),
    );
    await assert.rejects(readBoundedJsonl(path, 0, () => {}));
  });
});
