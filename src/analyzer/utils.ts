import crypto from "node:crypto";
import path from "node:path";

export function stableId(...parts: Array<string | undefined | null>): string {
  const raw = parts.filter(Boolean).join("::").trim().toLowerCase();
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 14);
}

export function toSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function pathSlug(relPath: string): string {
  return toSlug(relPath.replace(/\\/g, "/"));
}

export function relativePath(absPath: string, root: string): string {
  return path.relative(root, absPath).split(path.sep).join("/");
}

export function dirSlug(relPath: string): string {
  const normalized = relPath.split("/");
  const candidates = normalized
    .filter(segment => segment && segment !== "src" && segment !== "pages" && segment !== "views")
    .slice(0, 2);
  return toSlug(candidates.join("_")) || "root";
}

export function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

export function deepEqual<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
