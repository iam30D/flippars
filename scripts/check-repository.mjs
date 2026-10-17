import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const root = process.cwd();
const execFile = promisify(execFileCallback);
const requiredFiles = [
  "AGENTS.md",
  "DECISIONS.md",
  "TECH_DEBT.md",
  "docs/project-memory.md",
  "docs/signal-specification.md",
  "docs/model-governance.md",
  "apps/api/package.json",
  "apps/mobile/package.json",
  "packages/contracts/package.json",
  "packages/model-artifact/package.json",
  "packages/model-lab/package.json",
  "packages/signal-core/package.json",
];
const sourceExtensions = new Set([
  ".cjs",
  ".example",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".md",
  ".ps1",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
];

const prohibitedTrackedPathPatterns = [
  /(^|\/)\.eas(\/|$)/u,
  /(^|\/)\.expo(\/|$)/u,
  /(^|\/)(?:artifacts|coverage|data|dist|logs|models|node_modules)(\/|$)/u,
  /(^|\/)credentials\.json$/u,
  /(^|\/)expo-env\.d\.ts$/u,
  /\.(?:jks|key|mobileprovision|p12|p8|pem)$/u,
];

function isForbiddenEnvironmentFile(path) {
  const name = path.split("/").at(-1) ?? "";
  return name.startsWith(".env") && !name.endsWith(".example");
}

const failures = [];
for (const path of requiredFiles) {
  try {
    const details = await stat(join(root, path));
    if (!details.isFile()) {
      failures.push(`${path} is not a file`);
    }
  } catch {
    failures.push(`missing required file: ${path}`);
  }
}

const { stdout } = await execFile(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  },
);
const trackedPaths = stdout.split("\0").filter(Boolean);

for (const path of trackedPaths) {
  const absolute = join(root, path);
  try {
    if (!(await stat(absolute)).isFile()) continue;
  } catch {
    continue;
  }
  if (
    isForbiddenEnvironmentFile(path) ||
    prohibitedTrackedPathPatterns.some((pattern) => pattern.test(path))
  ) {
    failures.push(`forbidden tracked file: ${path}`);
  }
  const extension = extname(path);
  if (!sourceExtensions.has(extension)) {
    continue;
  }
  const content = await readFile(absolute, "utf8");
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) {
      failures.push(`possible committed secret in ${path}`);
    }
  }
  if (
    path !== "TECH_DEBT.md" &&
    path !== "scripts/check-repository.mjs" &&
    /\b(?:FIXME|TODO|XXX)\b/u.test(content)
  ) {
    failures.push(`untracked work marker in ${path}; record it in TECH_DEBT.md`);
  }
}

if (failures.length > 0) {
  console.error("Repository checks failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Repository structure and secret checks passed.");
}
