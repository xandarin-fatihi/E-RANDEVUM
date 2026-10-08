import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../docs/", import.meta.url));
const port = Number(process.env.PAGES_PORT || 4174);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const name = url.pathname === "/" ? "index.html" : normalize(url.pathname.replace(/^\//, ""));
  const target = resolve(root, name);
  if (!target.startsWith(resolve(root)) || !existsSync(target)) { res.writeHead(404); res.end("Not found"); return; }
  res.writeHead(200, { "Content-Type": types[extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(readFileSync(target));
}).listen(port, "127.0.0.1", () => console.log(`Pages demo: http://127.0.0.1:${port}`));
