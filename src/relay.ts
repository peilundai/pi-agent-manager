/**
 * Entry point of the detached relay process (`dist/relay.js`). The extension starts it with
 * Electron's Node (`ELECTRON_RUN_AS_NODE=1`) and writes one JSON config line to its stdin; the
 * config carries Pi's environment, so secrets never appear on a command line. The relay answers
 * with one line on stdout (`relay.ready` or `relay.failed`) and then runs on its own.
 */
import { JsonlDecoder } from "./pi/jsonl";
import { startRelay, type RelayConfig } from "./pi/relay-server";

function reply(record: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => process.stdout.write(`${JSON.stringify(record)}\n`, () => resolve()));
}

async function run(config: RelayConfig): Promise<void> {
  try {
    const relay = await startRelay(config);
    await reply({ type: "relay.ready", pid: relay.pid });
    await relay.closed;
    process.exit(0);
  } catch (error) {
    await reply({ type: "relay.failed", message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

// The window that launched us can go away at any time; that must not take the relay with it.
process.on("SIGHUP", () => undefined);
process.stdout.on("error", () => undefined);

let started = false;
const decoder = new JsonlDecoder((record) => {
  if (started) return;
  started = true;
  void run(record as RelayConfig);
});
process.stdin.on("data", (chunk: Buffer) => decoder.push(chunk));
process.stdin.on("end", () => {
  decoder.end();
  if (!started) process.exit(2);
});
