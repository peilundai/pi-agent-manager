export interface ZipArchiveEntry {
  data: Buffer;
  mode: number;
}

export function readZipArchive(path: string): Promise<Map<string, ZipArchiveEntry>>;
export function extractZipArchive(
  entries: ReadonlyMap<string, ZipArchiveEntry>,
  destination: string,
): Promise<void>;
