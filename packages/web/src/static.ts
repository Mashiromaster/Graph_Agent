/**
 * Static asset loader for the Graph Agent Studio web UI.
 *
 * The four vanilla web-UI files live in `<packageRoot>/assets/`. This module is
 * compiled to `<packageRoot>/dist/static.js`, so `../assets/<name>` resolved
 * against `import.meta.url` points at the sibling `assets/` dir — the files are
 * available at runtime after build WITHOUT a copy step. Reads are cached because
 * the assets are static.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface StaticAsset {
  readonly bytes: Buffer;
  readonly contentType: string;
}

interface AssetSpec {
  readonly file: string;
  readonly contentType: string;
}

const ROUTES: Readonly<Record<string, AssetSpec>> = Object.freeze({
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/assets/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
  "/assets/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", contentType: "image/svg+xml" },
});

const cache = new Map<string, Buffer>();

function readAsset(file: string): Buffer {
  const cached = cache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const path = fileURLToPath(new URL(`../assets/${file}`, import.meta.url));
  const bytes = readFileSync(path);
  cache.set(file, bytes);
  return bytes;
}

/**
 * Map a request pathname to a served asset, or null when the path is not a
 * known static route. Fail-closed: unknown paths return null (the caller 404s).
 */
export function staticFile(pathname: string): StaticAsset | null {
  const spec = ROUTES[pathname];
  if (spec === undefined) {
    return null;
  }
  return { bytes: readAsset(spec.file), contentType: spec.contentType };
}
