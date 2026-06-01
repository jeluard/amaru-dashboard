import { mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, "dist");
const wasmDir = path.join(rootDir, "wasm");

await mkdir(outDir, { recursive: true });

// On macOS, Apple Clang has no wasm32 backend; use Homebrew LLVM instead.
// On Linux the system clang supports wasm32 natively so no override is needed.
if (process.platform === "darwin") {
  const llvmPrefix = execFileSync("brew", ["--prefix", "llvm"], { encoding: "utf8" }).trim();
  process.env.CC_wasm32_unknown_unknown = `${llvmPrefix}/bin/clang`;
  process.env.AR_wasm32_unknown_unknown = `${llvmPrefix}/bin/llvm-ar`;
}

// Build the amaru-kernel WASM module
console.log("[wasm-pack] Building amaru-kernel-wasm...");
execFileSync(
  "wasm-pack",
  ["build", "--target", "web", "--out-dir", "pkg", "--release"],
  { cwd: wasmDir, stdio: "inherit" }
);
console.log("[wasm-pack] Done.");

const publicPath = process.env.PUBLIC_PATH ?? "";

await esbuild.build({
  absWorkingDir: rootDir,
  entryPoints: ["src/main.js"],
  bundle: true,
  outdir: "dist",
  entryNames: "[name]",
  assetNames: "[name]-[hash]",
  format: "esm",
  target: "es2022",
  sourcemap: true,
  publicPath,
  loader: {
    ".json": "json",
    ".wasm": "file"
  },
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString())
  }
});

const cssInput = await readFile(path.join(rootDir, "src/styles.css"), "utf8");
await writeFile(path.join(outDir, "styles.css"), cssInput, "utf8");

const htmlInput = await readFile(path.join(rootDir, "index.html"), "utf8");
const baseTag = publicPath ? `<base href="${publicPath}/">\n  ` : "";
await writeFile(
  path.join(rootDir, "dist/index.html"),
  htmlInput
    .replace("<head>", `<head>\n  ${baseTag}`.trimEnd())
    .replace("./dist/main.js", "./main.js"),
  "utf8"
);

