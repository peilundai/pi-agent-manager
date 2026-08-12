import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/resources", { recursive: true });

await Promise.all([
  build({
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode", "node-pty"],
    sourcemap: true,
  }),
  build({
    entryPoints: ["src/webview/main.tsx"],
    outfile: "dist/webview.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    jsx: "automatic",
    sourcemap: true,
  }),
  build({
    entryPoints: ["resources/pi-status.ts"],
    outfile: "dist/resources/pi-status.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: true,
  }),
]);

const [xtermCss, managerCss] = await Promise.all([
  readFile("node_modules/@xterm/xterm/css/xterm.css", "utf8"),
  readFile("src/webview/styles.css", "utf8"),
]);

await Promise.all([
  writeFile("dist/webview.css", `${xtermCss}\n${managerCss}`, "utf8"),
  copyFile("src/webview/index.html", "dist/index.html"),
]);
