// Prints coverage/coverage-summary.json as a Markdown table (for $GITHUB_STEP_SUMMARY).
import { existsSync, readFileSync } from "node:fs";

const file = "coverage/coverage-summary.json";
if (!existsSync(file)) {
  console.log("### Coverage\n\nNo coverage summary was produced.");
  process.exit(0);
}
const { total } = JSON.parse(readFileSync(file, "utf8"));
const rows = ["lines", "statements", "functions", "branches"].map(
  (key) => `| ${key[0].toUpperCase()}${key.slice(1)} | ${total[key].pct.toFixed(2)}% | ${total[key].covered}/${total[key].total} |`,
);
console.log(["### Coverage", "", "| Metric | % | Covered |", "|---|---|---|", ...rows].join("\n"));
