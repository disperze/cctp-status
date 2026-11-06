import { createReadStream, existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { defineConfig, type Connect } from "vite";

// Locally, serve the JSON written by `npm run snapshot` at /data/*. In production
// the page reads VITE_DATA_URL (the `data` branch on raw.githubusercontent.com).
const dataDir = resolve(process.env.DATA_DIR || "data");

const serveData: Connect.NextHandleFunction = (req, res, next) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0]!);
  const file = join(dataDir, rel);
  if (!file.startsWith(dataDir + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  createReadStream(file).pipe(res);
};

export default defineConfig({
  root: "web",
  base: "./", // works under https://<user>.github.io/<repo>/
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
  plugins: [
    {
      name: "local-data",
      configureServer(server) {
        server.middlewares.use("/data", serveData);
      },
      configurePreviewServer(server) {
        server.middlewares.use("/data", serveData);
      },
    },
  ],
});
