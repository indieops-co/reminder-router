// Smoke test: launch a real VS Code with the extension, in a workspace, against a live daemon.
import { runTests } from "@vscode/test-electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
try {
  await runTests({
    extensionDevelopmentPath: path.resolve(here, ".."),
    extensionTestsPath: path.resolve(here, "suite.cjs"),
    launchArgs: [path.resolve(here, "..", ".."), "--disable-extensions", "--disable-gpu", "--no-sandbox", "--user-data-dir=/tmp/vscode-test-user"],
    extensionTestsEnv: { HANDOFF_PORT: process.env.HANDOFF_PORT ?? "7399" },
  });
} catch (err) {
  console.error("Failed to run tests", err);
  process.exit(1);
}
