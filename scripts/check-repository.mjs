import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";

const root = process.cwd();
const ignoredDirectories = new Set([
  ".git",
  ".expo",
  "coverage",
  "dist",
  "node_modules",
  "web-build",
]);
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
  "packages/model-lab/package.json",
  "packages/signal-core/package.json",
];
const sourceExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
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

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
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

for (const absolute of await walk(root)) {
  const path = relative(root, absolute).replaceAll("\\", "/");
  const extensionIndex = path.lastIndexOf(".");
  const extension = extensionIndex >= 0 ? path.slice(extensionIndex) : "";
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
