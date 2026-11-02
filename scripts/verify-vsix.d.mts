export const ARTIFACT_NAME: string;
export function verifyRequiredFiles(inventory: readonly string[]): void;
export function validateVsixManifest(xml: string): void;
export function verifyVsix(artifact?: string): Promise<void>;
