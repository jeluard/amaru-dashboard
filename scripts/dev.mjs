import { createServer } from "node:http";
import { stat, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 8082);
const wasmDir = path.join(rootDir, "wasm");

// Build the amaru-kernel WASM module once at dev startup
console.log("[wasm-pack] Building amaru-kernel-wasm (dev)...");
execFileSync(
  "wasm-pack",
  ["build", "--target", "web", "--out-dir", "pkg", "--dev"],
  { cwd: wasmDir, stdio: "inherit" }
);
console.log("[wasm-pack] Done.");

const ctx = await esbuild.context({
  absWorkingDir: rootDir,
  entryPoints: ["src/main.js"],
  bundle: true,
  outdir: "dist",
  entryNames: "[name]",
  assetNames: "[name]-[hash]",
  format: "esm",
  target: "es2022",
  sourcemap: true,
  loader: {
    ".json": "json",
    ".wasm": "file"
  },
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString())
  }
});

await ctx.watch();

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm"
};

async function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const body = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-cache"
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const requestPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];

    if (requestPath === "/styles.css") {
      await sendFile(res, path.join(rootDir, "src/styles.css"));
      return;
    }

    if (requestPath.startsWith("/raw/")) {
      await sendFile(res, path.join(rootDir, requestPath));
      return;
    }

    if (requestPath === "/index.html") {
      await sendFile(res, path.join(rootDir, "index.html"));
      return;
    }

    const distTarget = path.join(rootDir, requestPath);
    await stat(distTarget);
    await sendFile(res, distTarget);
  } catch (error) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Not found: ${req.url}`);
  }
});

server.listen(port, () => {
  console.log(`dev server listening on http://localhost:${port}`);
});