import type { PackageTarget } from "./package-target.mjs";

export function verifyRequiredFiles(inventory: readonly string[]): void;
export function verifyVsix(target?: PackageTarget, artifact?: string): Promise<void>;
