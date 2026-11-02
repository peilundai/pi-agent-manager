import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const production = process.env.NODE_ENV !== "development";

await Promise.all([
  build({
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    sourcemap: true,
    minify: production,
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
    minify: production,
    define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
  }),
]);

const [codiconCss, themeCss, chatCss] = await Promise.all([
  readFile("node_modules/@vscode/codicons/dist/codicon.css", "utf8"),
  readFile("src/webview/theme.css", "utf8"),
  readFile("src/webview/styles.css", "utf8"),
]);

await Promise.all([
  writeFile("dist/webview.css", `${codiconCss}\n${themeCss}\n${chatCss}`, "utf8"),
  copyFile("node_modules/@vscode/codicons/dist/codicon.ttf", "dist/codicon.ttf"),
]);
