export interface HostPlatform {
  platform: string;
  arch: string;
  libc?: "glibc" | "musl";
}

export interface PackageTarget {
  platform: "darwin" | "win32" | "linux";
  arch: "x64" | "arm64";
  target: string;
  nativeFiles: string[];
}

export interface RuntimePlatform {
  platform: string;
  arch: string;
  report?: { header?: { glibcVersionRuntime?: string } };
}

export const ARTIFACT_NAME: "pi-agent-manager-0.1.0.vsix";
export const commonNodePtyRuntimeFiles: readonly string[];
export function derivePackageTarget(host: HostPlatform): PackageTarget;
export function deriveCurrentPackageTarget(runtime?: RuntimePlatform): PackageTarget;
export function prepareNativeRuntime(target: PackageTarget, root?: string): Promise<void>;
export function createTargetIgnore(baseIgnore: string, target: PackageTarget): string;
export function packageArguments(target: PackageTarget, ignoreFile: string): string[];
export function validateArchiveInventory(inventory: readonly string[], target: PackageTarget): void;
export function validateVsixManifest(manifest: string, target: PackageTarget): void;
