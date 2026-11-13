import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

/** Bundles `src/relay.ts` the way `scripts/build.mjs` does, into a temporary directory. */
export async function buildRelayScript(): Promise<string> {
  const outfile = join(await mkdtemp(join(tmpdir(), "pi-relay-test-")), "relay.js");
  await build({ entryPoints: ["src/relay.ts"], outfile, bundle: true, platform: "node", format: "cjs", target: "node20", logLevel: "silent" });
  return outfile;
}
