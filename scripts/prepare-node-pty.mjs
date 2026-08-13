import {
  deriveCurrentPackageTarget,
  prepareNativeRuntime,
} from "./package-target.mjs";

const target = deriveCurrentPackageTarget();
await prepareNativeRuntime(target);
console.log(`Prepared node-pty runtime for ${target.target}.`);
