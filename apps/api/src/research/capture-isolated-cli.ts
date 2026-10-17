import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runIsolatedCapture } from "./capture-isolated-session.js";
import { runObservedCapture, verifyObservedRuntime } from "./capture-observed-cli.js";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") {
      process.stdout.write(
        "Usage: npm run capture:market:isolated -- --output-parent <existing-external-directory> [--seconds 600] [--max-mib 256]\n",
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
        throw new Error("Invalid isolated capture arguments");
      flags.set(key, value);
    }
    const result = await runObservedCapture(
      {
        outputParent: flags.get("--output-parent") ?? "",
        seconds: Number(flags.get("--seconds") ?? "600"),
        maxMiB: Number(flags.get("--max-mib") ?? "256"),
      },
      runIsolatedCapture,
    );
    process.stdout.write(
      JSON.stringify(
        {
          root: result.root,
          completionState: result.completionState,
          witness: await verifyObservedRuntime(result.root),
        },
        null,
        2,
      ) + "\n",
    );
    if (result.completionState === "INCOMPLETE") process.exitCode = 1;
  })().catch(() => {
    process.stderr.write(
      "Isolated research capture failed. Preserve partial evidence; no model was enabled.\n",
    );
    process.exitCode = 1;
  });
}
