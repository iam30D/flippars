import { loadConfig } from "./config.js";
import { loadLocalEnvironment } from "./environment.js";

const environmentPath = process.argv[2] ?? ".env";
loadLocalEnvironment(environmentPath);
const config = loadConfig();
if (config.nodeEnv !== "production") {
  throw new Error("NODE_ENV must be production for this check");
}

process.stdout.write("Production API environment is valid. No secrets were printed.\n");
