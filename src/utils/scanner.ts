import fs from "fs";
import path from "path";
import crypto from "crypto";


/** 排除的目录名 */
const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "dist", "build", ".next", ".nuxt", ".output",
  ".idea", ".vscode", ".vs", ".eclipse",
  "__pycache__", ".cache", ".tmp", ".temp",
  "coverage", ".nyc_output",
]);

/** 排除的文件名 */
const EXCLUDED_FILES = new Set([
  ".DS_Store", "Thumbs.db", ".gitignore", ".gitattributes",
  ".editorconfig", ".env.local", ".env.production",
]);

export function scanFiles(dir:string){

    const result:string[] = [];


    function walk(current:string){

        const files = fs.readdirSync(current);


        for(const file of files){

            // [L1] 过滤隐藏文件和排除文件
            if (file.startsWith(".") && EXCLUDED_FILES.has(file)) continue;
            if (EXCLUDED_FILES.has(file)) continue;

            const fullPath = path.join(current,file);

            const stat = fs.statSync(fullPath);


            if(stat.isDirectory()){

                // [L1] 排除无意义目录（包括隐藏目录）
                if (file.startsWith(".")) continue;
                if (EXCLUDED_DIRS.has(file)) continue;

                walk(fullPath);

            }else{

                result.push(fullPath);

            }

        }

    }


    walk(dir);


    return result;

}

// ============ P0-1: 文件指纹与快照 ============

/** 文件快照结构 */
export interface FileSnapshot {
  path: string;       // 归一化后的绝对路径
  size: number;       // 文件大小（字节）
  mtime: string;      // 最后修改时间 ISO 字符串
  hash?: string;      // SHA-256 哈希（仅小文件生成）
  /** [L2] 标记 hash 是否被跳过及原因 */
  hashSkipped?: "too_large" | "binary" | "error";
}

/** hash 计算的文件大小上限：1MB，超过则跳过 */
const HASH_SIZE_LIMIT = 1024 * 1024;

/** 已知二进制扩展名，不参与 hash */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac",
  ".db", ".sqlite",
]);

/**
 * 计算文件的 SHA-256 哈希值
 * 仅对小于 HASH_SIZE_LIMIT 且非二进制的文件计算
 * @returns hash 字符串，或 null（文件过大/二进制/不存在）
 */
export async function generateFileHash(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(filePath);

    if (!stat.isFile()) return null;
    if (stat.size > HASH_SIZE_LIMIT) return null;

    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return null;

    const content = await fs.promises.readFile(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

/**
 * [L2] 获取 hash 跳过原因
 */
function getHashSkipReason(filePath: string, stat: fs.Stats): "too_large" | "binary" | undefined {
  if (stat.size > HASH_SIZE_LIMIT) return "too_large";
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return "binary";
  return undefined;
}

/**
 * 为指定的文件路径列表创建快照
 * - 文件不存在时跳过（不报错）
 * - 路径去重（归一化后）
 * - 自动解析相对路径（基于 basePath）
 * - 大文件/二进制文件仅记录 mtime + size，不生成 hash
 * - [L2] 标记 hashSkipped 原因
 */
export async function createFileSnapshots(
  files: string[],
  basePath: string
): Promise<FileSnapshot[]> {
  const seen = new Set<string>();
  const snapshots: FileSnapshot[] = [];

  for (const file of files) {
    if (!file || typeof file !== "string") continue;

    // 归一化路径
    const normalized = path.isAbsolute(file)
      ? path.resolve(file)
      : path.resolve(basePath, file);

    // 去重
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    // 读取文件信息
    try {
      const stat = await fs.promises.stat(normalized);

      if (!stat.isFile()) continue;

      const snapshot: FileSnapshot = {
        path: normalized,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      };

      const hash = await generateFileHash(normalized);
      if (hash) {
        snapshot.hash = hash;
      } else {
        // [L2] 标记 hash 跳过原因
        const skipReason = getHashSkipReason(normalized, stat);
        if (skipReason) {
          snapshot.hashSkipped = skipReason;
        }
      }

      snapshots.push(snapshot);
    } catch {
      // 文件不存在或无权限，跳过
    }
  }

  return snapshots;
}
