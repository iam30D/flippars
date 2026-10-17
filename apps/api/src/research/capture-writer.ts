import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";

/** Exclusive creation, bounded bytes, synchronous writes, and hash-linked records. */
export class CaptureWriter {
  private readonly descriptor: number;
  private digest = "0".repeat(64);
  private bytes = 0;
  private count = 0;
  private closed = false;
  private writeFailed = false;
  private readonly fileDigest = createHash("sha256");

  constructor(
    path: string,
    private readonly maxBytes: number,
  ) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1_024 ||
      maxBytes > 1_073_741_824
    ) {
      throw new Error("Invalid capture byte limit");
    }
    this.descriptor = openSync(path, "wx", 0o600);
  }

  append(record: Readonly<Record<string, unknown>>): void {
    if (this.closed) throw new Error("Capture is closed");
    const payload = JSON.stringify({
      schemaVersion: "flippars.market-capture/1",
      sequence: this.count + 1,
      previousSha256: this.digest,
      productionEligible: false,
      guardVerdict: "UNASSESSED",
      record,
    });
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const line = Buffer.from(JSON.stringify({ payload, sha256 }) + "\n", "utf8");
    if (this.bytes + line.length > this.maxBytes) throw new Error("CAPTURE_BYTE_LIMIT");
    try {
      let offset = 0;
      while (offset < line.length) {
        const written = writeSync(this.descriptor, line, offset, line.length - offset);
        if (written <= 0) throw new Error("Capture write made no progress");
        offset += written;
      }
    } catch (error) {
      this.writeFailed = true;
      throw error;
    }
    this.bytes += line.length;
    this.fileDigest.update(line);
    this.count++;
    this.digest = sha256;
  }

  sync(): void {
    if (!this.closed) fsyncSync(this.descriptor);
  }

  close(): { bytes: number; records: number; finalSha256: string; fileSha256: string } {
    if (!this.closed) {
      try {
        this.sync();
      } finally {
        closeSync(this.descriptor);
        this.closed = true;
      }
    }
    if (this.writeFailed)
      throw new Error("Capture has an incomplete write; quarantine the session");
    return {
      bytes: this.bytes,
      records: this.count,
      finalSha256: this.digest,
      fileSha256: this.fileDigest.copy().digest("hex"),
    };
  }
}
