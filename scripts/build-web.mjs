// フロント静的アセットのビルド: src/web → public/
import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const outDir = resolve(root, "public");

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [resolve(root, "src/web/main.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: resolve(outDir, "app.js"),
  sourcemap: true,
});

await copyFile(resolve(root, "src/web/index.html"), resolve(outDir, "index.html"));
await copyFile(resolve(root, "src/web/styles.css"), resolve(outDir, "styles.css"));

console.log("web assets built into public/");
