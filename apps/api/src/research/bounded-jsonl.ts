import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Consumers must withhold results until the final digest has been checked. */
export async function readBoundedJsonl(
  path: string,
  maximumBytes: number,
  accept: (line: string) => void,
): Promise<{ bytes: number; sha256: string }> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error("Invalid JSONL byte limit");
  const stream = createReadStream(path, { highWaterMark: 65_536 });
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = Buffer.alloc(0);
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      if (bytes > maximumBytes) throw new Error("JSONL byte limit exceeded");
      hash.update(buffer);
      pending = Buffer.concat([pending, buffer]);
      let newline = pending.indexOf(10);
      while (newline !== -1) {
        if (newline === 0 || newline > 524_288)
          throw new Error("Invalid JSONL line length");
        accept(decoder.decode(pending.subarray(0, newline)));
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(10);
      }
      if (pending.length > 524_288) throw new Error("JSONL line limit exceeded");
    }
    if (pending.length !== 0) throw new Error("JSONL final newline missing");
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    stream.destroy();
    await closed;
  }
}
