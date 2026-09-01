#!/usr/bin/env node
// Silence Node's ExperimentalWarning for node:sqlite before anything loads it.
const original = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const name = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  const msg = typeof warning === "string" ? warning : warning?.message ?? "";
  if (name === "ExperimentalWarning" && /SQLite/i.test(msg)) return;
  return original.call(process, warning, ...rest);
};
await import("../dist/cli/main.js");
