import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import yauzl from "yauzl";

function openZip(path) {
  return new Promise((resolveOpen, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zipFile) => {
      if (error) reject(error);
      else if (!zipFile) reject(new Error(`Unable to open ZIP archive: ${path}`));
      else resolveOpen(zipFile);
    });
  });
}

function readEntry(zipFile, entry) {
  return new Promise((resolveEntry, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      if (!stream) {
        reject(new Error(`Unable to read ZIP entry: ${entry.fileName}`));
        return;
      }
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.once("error", reject);
      stream.once("end", () => {
        resolveEntry({
          data: Buffer.concat(chunks),
          mode: (entry.externalFileAttributes >>> 16) & 0xffff,
        });
      });
    });
  });
}

export async function readZipArchive(path) {
  const zipFile = await openZip(path);
  return await new Promise((resolveEntries, reject) => {
    const entries = new Map();
    zipFile.once("error", reject);
    zipFile.once("end", () => resolveEntries(entries));
    zipFile.on("entry", (entry) => {
      if (entry.fileName.endsWith("/")) {
        zipFile.readEntry();
        return;
      }
      readEntry(zipFile, entry).then(
        (result) => {
          entries.set(entry.fileName, result);
          zipFile.readEntry();
        },
        (error) => {
          zipFile.close();
          reject(error);
        },
      );
    });
    zipFile.readEntry();
  });
}

export async function extractZipArchive(entries, destination) {
  const root = resolve(destination);
  await mkdir(root, { recursive: true });
  for (const [name, entry] of entries) {
    const path = resolve(root, ...name.split("/"));
    if (!path.startsWith(`${root}${sep}`)) throw new Error(`Unsafe ZIP entry path: ${name}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.data);
    if (process.platform !== "win32" && entry.mode) await chmod(path, entry.mode & 0o777);
  }
}
