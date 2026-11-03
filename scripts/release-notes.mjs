// Prints the CHANGELOG.md section for the given version (used by the release workflow).
import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/release-notes.mjs <version>");
  process.exit(1);
}
const changelog = readFileSync("CHANGELOG.md", "utf8");
const heading = new RegExp(`^## ${version.replace(/\./g, "\\.")}(?:\\s|$).*$`, "m");
const match = heading.exec(changelog);
if (!match) {
  console.log(`Pi Agent Manager ${version}`);
  process.exit(0);
}
const rest = changelog.slice(match.index + match[0].length);
const next = rest.search(/^## /m);
console.log((next === -1 ? rest : rest.slice(0, next)).trim());
