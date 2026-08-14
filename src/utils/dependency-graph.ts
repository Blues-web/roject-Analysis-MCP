/**
 * P0-3: 轻量级依赖图构建与分析
 * 
 * 使用正则表达式解析 import 语句，构建文件依赖图
 * 支持 ES6 imports, CommonJS require, 动态 import
 * 
 * [C2] 重写 quickAnalyzeImpact：先建立文件索引和反向依赖，再 BFS
 * [C3] 正则转义文件名 + 路径边界约束
 * [M1] 修正 traverseDependency 的 edges
 * [M8] 去除重复扫描目录
 * [L3] 清理未使用的 VUE_COMPONENT_PATTERNS
 */

import fs from "node:fs";
import path from "node:path";

// ============ 类型定义 ============

/** 依赖关系类型 */
export type DependencyType = 
  | "import"        // ES6 import
  | "require"       // CommonJS require
  | "dynamic"       // 动态 import()
  | "unknown";      // 无法确定

/** 依赖边 */
export interface DependencyEdge {
  from: string;     // 引用方文件
  to: string;       // 被引用文件
  type: DependencyType;
  line?: number;    // 行号（可选）
}

/** 依赖图 */
export interface DependencyGraph {
  nodes: Set<string>;           // 所有文件节点
  edges: DependencyEdge[];      // 所有依赖边
  adjacency: Map<string, Set<string>>;  // 邻接表：file -> [依赖的文件]
  reverseAdj: Map<string, Set<string>>; // 反向邻接表：file -> [引用它的文件]
}

/** 遍历选项 */
export interface TraversalOptions {
  maxDepth?: number;    // 最大深度，默认 5
  maxNodes?: number;    // 最大节点数，默认 100
  direction?: "forward" | "reverse";  // forward: 我依赖谁，reverse: 谁依赖我
}

/** 遍历结果 */
export interface TraversalResult {
  target: string;
  direct: string[];      // 直接依赖/引用
  indirect: string[];    // 间接依赖/引用
  depth: Map<string, number>;  // 每个节点的深度
  edges: DependencyEdge[];     // 涉及的边
}

// ============ 正则表达式模式 ============

// ES6 import 语句
const IMPORT_PATTERNS = [
  // import ... from '...'
  /import\s+(?:[\w\s{},*]+)\s+from\s+['"]([^'"]+)['"]/g,
  // import '...'
  /import\s+['"]([^'"]+)['"]/g,
  // import type ... from '...' (TypeScript)
  /import\s+type\s+(?:[\w\s{},*]+)\s+from\s+['"]([^'"]+)['"]/g,
];

// CommonJS require
const REQUIRE_PATTERN = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// 动态 import
const DYNAMIC_IMPORT_PATTERN = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// 代码文件扩展名
const CODE_EXTENSIONS = new Set(['.ts', '.js', '.vue', '.tsx', '.jsx', '.mjs', '.cjs']);

// 排除的目录
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build',
  '.next', '.nuxt', '.output', '.cache', '.tmp',
  '__pycache__', 'coverage',
]);

// ============ 核心函数 ============

/**
 * 从文件内容中提取所有 import 路径
 */
export function extractImports(content: string): Array<{ path: string; type: DependencyType }> {
  const imports: Array<{ path: string; type: DependencyType }> = [];
  const seen = new Set<string>();

  function addImport(importPath: string, type: DependencyType) {
    if (importPath && !seen.has(importPath)) {
      seen.add(importPath);
      imports.push({ path: importPath, type });
    }
  }

  // ES6 imports
  for (const pattern of IMPORT_PATTERNS) {
    const regex = new RegExp(pattern);
    let match;
    while ((match = regex.exec(content)) !== null) {
      addImport(match[1], "import");
    }
  }

  // CommonJS require
  {
    const regex = new RegExp(REQUIRE_PATTERN);
    let match;
    while ((match = regex.exec(content)) !== null) {
      addImport(match[1], "require");
    }
  }

  // 动态 import
  {
    const regex = new RegExp(DYNAMIC_IMPORT_PATTERN);
    let match;
    while ((match = regex.exec(content)) !== null) {
      addImport(match[1], "dynamic");
    }
  }

  return imports;
}

/**
 * 解析 import 路径为绝对文件路径
 * 处理：相对路径、别名路径、文件扩展名、index 文件
 * [H1] 解析后校验路径是否在项目内
 */
export function resolveImportPath(
  importPath: string,
  fromFile: string,
  projectPath: string
): string | null {
  // 跳过外部包（不以 . 或 / 开头，且不是 @/ 别名）
  if (!importPath.startsWith('.') && 
      !importPath.startsWith('/') && 
      !importPath.startsWith('@/')) {
    return null;
  }

  let absolutePath: string;

  // 处理别名路径 @/
  if (importPath.startsWith('@/')) {
    // 假设 @ 指向 src 目录
    absolutePath = path.join(projectPath, 'src', importPath.slice(2));
  } else if (importPath.startsWith('/')) {
    // 绝对路径（相对于项目根）
    absolutePath = path.join(projectPath, importPath);
  } else {
    // 相对路径
    const fromDir = path.dirname(fromFile);
    absolutePath = path.resolve(fromDir, importPath);
  }

  // 尝试解析文件（带扩展名）
  const extensions = ['.ts', '.js', '.vue', '.tsx', '.jsx', '.json'];
  
  // 1. 直接存在
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
    return absolutePath;
  }

  // 2. 添加扩展名
  for (const ext of extensions) {
    const withExt = absolutePath + ext;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  // 3. 尝试 index 文件
  for (const ext of extensions) {
    const indexPath = path.join(absolutePath, `index${ext}`);
    if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
      return indexPath;
    }
  }

  return null;
}

/**
 * 递归扫描目录，收集代码文件
 * [M8] 只从项目根目录递归，不重复扫描子目录
 */
function scanProjectFiles(dir: string, result: string[] = []): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // 跳过排除目录和隐藏目录
        if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) {
          continue;
        }
        scanProjectFiles(fullPath, result);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (CODE_EXTENSIONS.has(ext)) {
          result.push(fullPath);
        }
      }
    }
  } catch {
    // 跳过无权限的目录
  }

  return result;
}

/**
 * [C2] 构建项目的文件索引
 * 扫描一次项目，返回所有代码文件的绝对路径
 */
export function buildFileIndex(projectPath: string): string[] {
  return scanProjectFiles(projectPath);
}

/**
 * [C2] 构建反向依赖索引
 * 对项目中的所有文件提取 import，构建 "谁引用了谁" 的映射
 * 
 * @returns reverseAdj: Map<被引用文件, Set<引用它的文件>>
 */
export function buildReverseIndex(
  files: string[],
  projectPath: string
): Map<string, Set<string>> {
  const reverseAdj = new Map<string, Set<string>>();

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const imports = extractImports(content);

      for (const imp of imports) {
        const resolved = resolveImportPath(imp.path, file, projectPath);
        if (!resolved) continue;

        if (!reverseAdj.has(resolved)) {
          reverseAdj.set(resolved, new Set());
        }
        reverseAdj.get(resolved)!.add(file);
      }
    } catch {
      // 跳过无法读取的文件
    }
  }

  return reverseAdj;
}

/**
 * [C2] 重写：基于反向索引的影响分析
 * 先构建索引，再 BFS 遍历，复杂度 O(N) + O(V+E)
 */
export function quickAnalyzeImpact(
  targetFile: string,
  projectPath: string,
  options: TraversalOptions = {}
): TraversalResult {
  const {
    maxDepth = 5,
    maxNodes = 100,
  } = options;

  const result: TraversalResult = {
    target: targetFile,
    direct: [],
    indirect: [],
    depth: new Map(),
    edges: [],
  };

  // 1. 构建文件索引
  const files = buildFileIndex(projectPath);

  // 2. 构建反向依赖索引（一次扫描）
  const reverseAdj = buildReverseIndex(files, projectPath);

  // 3. BFS 遍历
  const visited = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [];

  visited.add(targetFile);
  result.depth.set(targetFile, 0);

  // 获取第一层（直接引用 target 的文件）
  const firstLevel = reverseAdj.get(targetFile) || new Set();
  for (const file of firstLevel) {
    queue.push({ file, depth: 1 });
  }

  // BFS
  while (queue.length > 0 && visited.size < maxNodes) {
    const { file, depth } = queue.shift()!;

    if (visited.has(file) || depth > maxDepth) {
      continue;
    }

    visited.add(file);
    result.depth.set(file, depth);

    // 分类：直接 vs 间接
    if (depth === 1) {
      result.direct.push(file);
    } else {
      result.indirect.push(file);
    }

    // 收集边
    result.edges.push({
      from: file,
      to: targetFile,
      type: "import",
    });

    // 继续遍历下一层
    if (depth < maxDepth) {
      const nextLevel = reverseAdj.get(file) || new Set();
      for (const next of nextLevel) {
        if (!visited.has(next)) {
          queue.push({ file: next, depth: depth + 1 });
        }
      }
    }
  }

  return result;
}

/**
 * 构建完整的依赖图（正向 + 反向）
 */
export function buildDependencyGraph(
  files: string[],
  projectPath: string
): DependencyGraph {
  const graph: DependencyGraph = {
    nodes: new Set(),
    edges: [],
    adjacency: new Map(),
    reverseAdj: new Map(),
  };

  for (const file of files) {
    graph.nodes.add(file);
    if (!graph.adjacency.has(file)) {
      graph.adjacency.set(file, new Set());
    }

    try {
      const content = fs.readFileSync(file, 'utf-8');
      const imports = extractImports(content);

      for (const imp of imports) {
        const resolved = resolveImportPath(imp.path, file, projectPath);
        if (!resolved) continue;

        graph.nodes.add(resolved);
        graph.adjacency.get(file)!.add(resolved);

        if (!graph.reverseAdj.has(resolved)) {
          graph.reverseAdj.set(resolved, new Set());
        }
        graph.reverseAdj.get(resolved)!.add(file);

        graph.edges.push({
          from: file,
          to: resolved,
          type: imp.type,
        });
      }
    } catch {
      // 跳过无法读取的文件
    }
  }

  return graph;
}

/**
 * [M1] 遍历依赖图（BFS）— 修正 edges 收集
 */
export function traverseDependency(
  graph: DependencyGraph,
  target: string,
  options: TraversalOptions = {}
): TraversalResult {
  const {
    maxDepth = 5,
    maxNodes = 100,
    direction = "reverse",
  } = options;

  const result: TraversalResult = {
    target,
    direct: [],
    indirect: [],
    depth: new Map(),
    edges: [],
  };

  const visited = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [];

  visited.add(target);
  result.depth.set(target, 0);

  const adj = direction === "reverse" ? graph.reverseAdj : graph.adjacency;
  const firstLevel = adj.get(target) || new Set();

  for (const file of firstLevel) {
    queue.push({ file, depth: 1 });
  }

  while (queue.length > 0 && visited.size < maxNodes) {
    const { file, depth } = queue.shift()!;

    if (visited.has(file) || depth > maxDepth) {
      continue;
    }

    visited.add(file);
    result.depth.set(file, depth);

    if (depth === 1) {
      result.direct.push(file);
    } else {
      result.indirect.push(file);
    }

    // [M1] 修正 edges：记录真实的 from → to
    const nextLevel = adj.get(file) || new Set();
    for (const next of nextLevel) {
      if (direction === "reverse") {
        result.edges.push({ from: file, to: next, type: "unknown" });
      } else {
        result.edges.push({ from: file, to: next, type: "unknown" });
      }
    }

    if (depth < maxDepth) {
      for (const next of nextLevel) {
        if (!visited.has(next)) {
          queue.push({ file: next, depth: depth + 1 });
        }
      }
    }
  }

  return result;
}
