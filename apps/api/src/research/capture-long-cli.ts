import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runLongCapture } from "./capture-session.js";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") {
      process.stdout.write(
        "Usage: npm run capture:market:long -- --output-parent <existing-external-directory> [--seconds 13500] [--max-mib 1024]\n",
      );
      return;
    }
    const flags = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      const value = args[index + 1];
      if (
        !key ||
        !["--output-parent", "--seconds", "--max-mib"].includes(key) ||
        !value ||
        flags.has(key)
      )
        throw new Error("Invalid long capture arguments");
      flags.set(key, value);
    }
    const result = await runLongCapture({
      outputParent: flags.get("--output-parent") ?? "",
      seconds: Number(flags.get("--seconds") ?? "13500"),
      maxMiB: Number(flags.get("--max-mib") ?? "1024"),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result["completionState"] !== "CAPTURED") process.exitCode = 1;
  })().catch(() => {
    process.stderr.write(
      "Long research capture failed. Preserve incomplete evidence; no model was enabled.\n",
    );
    process.exitCode = 1;
  });
}
