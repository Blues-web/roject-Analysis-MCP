import fs from "node:fs";
import path from "node:path";
import type {
  AnalyzedModule,
  AnalyzedPage,
  AnalyzedProject,
  ApiDefinition,
  ApiParam,
  EntityDefinition,
  EntityField,
  PageAction,
  PermissionDefinition,
  PermissionType,
  ResponseShape,
  RouteDefinition,
  StateDefinition,
  StoreModuleInfo,
  UiField,
} from "./types.js";
import { dirSlug, relativePath, stableId, toSlug, unique } from "./utils.js";

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  ".idea",
  ".vscode",
  "__pycache__",
  ".cache",
  ".tmp",
  ".temp",
  "coverage",
  ".nyc_output",
]);

const CODE_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".vue",
  ".mjs",
  ".cjs",
]);

const MAX_SCAN_FILES = 5000;
const MAX_FILE_SIZE = 2 * 1024 * 1024;

export type ScannedFileKind =
  | "route"
  | "page"
  | "component"
  | "api"
  | "store"
  | "config"
  | "model"
  | "permission"
  | "code";

export interface ScannedFile {
  absPath: string;
  relPath: string;
  ext: string;
  content: string;
  kind: ScannedFileKind;
}

function classifyFile(relPath: string, ext: string, content: string): ScannedFileKind {
  const lower = relPath.toLowerCase();
  const fileName = path.basename(lower);

  if (
    lower.includes("router") ||
    fileName === "routes.js" ||
    fileName === "routes.ts" ||
    fileName === "pages.json" ||
    fileName === "app.json"
  ) {
    return "route";
  }
  if (ext === ".vue") {
    if (lower.includes("components") || /^[A-Z]/.test(fileName)) return "component";
    if (lower.includes("views") || lower.includes("pages")) return "page";
    return "component";
  }
  if (
    lower.includes("api") ||
    lower.includes("services") ||
    fileName.includes("api") ||
    fileName.includes("request") ||
    fileName.includes("http") ||
    fileName.includes("service")
  ) {
    return "api";
  }
  if (
    lower.includes("store") ||
    lower.includes("stores") ||
    fileName.startsWith("store")
  ) {
    return "store";
  }
  if (
    fileName === "package.json" ||
    fileName.includes("vite.config") ||
    fileName.includes("vue.config") ||
    fileName.includes("webpack.config") ||
    fileName.includes("nuxt.config") ||
    fileName === "pages.json" ||
    fileName === "manifest.json" ||
    fileName.startsWith(".env") ||
    fileName === "tsconfig.json" ||
    fileName === "jsconfig.json"
  ) {
    return "config";
  }
  if (
    lower.includes("models") ||
    lower.includes("model") ||
    lower.includes("types") ||
    lower.includes("entity") ||
    lower.includes("dto")
  ) {
    return "model";
  }
  if (
    /permission|perms|auth|token|role|session|currentUser|userInfo/i.test(content)
  ) {
    return "permission";
  }
  return "code";
}

export function scanProjectFiles(root: string): ScannedFile[] {
  const result: ScannedFile[] = [];

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (result.length >= MAX_SCAN_FILES) return;
      if (entry.name.startsWith(".") || EXCLUDED_DIRS.has(entry.name)) continue;

      const absPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absPath);
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext) && ext !== ".json") continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_FILE_SIZE) continue;

      let content = "";
      try {
        content = fs.readFileSync(absPath, "utf-8");
      } catch {
        continue;
      }

      const relPath = relativePath(absPath, root);
      result.push({
        absPath,
        relPath,
        ext,
        content,
        kind: classifyFile(relPath, ext, content),
      });
    }
  }

  walk(root);
  return result.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function readPackageJson(root: string, files: ScannedFile[]): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  name?: string;
  version?: string;
} {
  const pkgFile = files.find(f => f.relPath === "package.json");
  if (!pkgFile) return { dependencies: {}, devDependencies: {} };
  try {
    const pkg = JSON.parse(pkgFile.content) as Record<string, unknown>;
    return {
      dependencies: (pkg.dependencies as Record<string, string>) || {},
      devDependencies: (pkg.devDependencies as Record<string, string>) || {},
      name: typeof pkg.name === "string" ? pkg.name : undefined,
      version: typeof pkg.version === "string" ? pkg.version : undefined,
    };
  } catch {
    return { dependencies: {}, devDependencies: {} };
  }
}

const FRAMEWORK_NAMES: Record<string, string> = {
  vue: "Vue",
  "vue-router": "Vue Router",
  vuex: "Vuex",
  pinia: "Pinia",
  "element-ui": "Element UI",
  "element-plus": "Element Plus",
  "ant-design-vue": "Ant Design Vue",
  "@dcloudio/uni-app": "UniApp",
  react: "React",
  "react-router": "React Router",
  next: "Next.js",
  nuxt: "Nuxt",
  axios: "Axios",
  express: "Express",
  koa: "Koa",
  fastify: "Fastify",
  "@nestjs/core": "NestJS",
  typeorm: "TypeORM",
  prisma: "Prisma",
  sequelize: "Sequelize",
  mysql2: "MySQL",
  pg: "PostgreSQL",
};

export function detectProjectMeta(
  projectName: string,
  root: string,
  files: ScannedFile[]
): AnalyzedProject {
  const pkg = readPackageJson(root, files);
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const frameworks = unique(
    Object.keys(allDeps)
      .map(key => FRAMEWORK_NAMES[key])
      .filter((name): name is string => Boolean(name))
  );

  const hasFrontend = frameworks.some(name =>
    ["Vue", "Vue Router", "Vuex", "Pinia", "Element UI", "Element Plus", "Ant Design Vue", "UniApp", "React", "React Router", "Next.js", "Nuxt"].includes(name)
  );
  const hasBackend = frameworks.some(name =>
    ["Express", "Koa", "Fastify", "NestJS", "TypeORM", "Prisma", "Sequelize", "MySQL", "PostgreSQL"].includes(name)
  ) || files.some(f => /(^|\/)(server|backend|api-server)(\/|$)/i.test(f.relPath));

  const type = hasFrontend && hasBackend
    ? "fullstack"
    : hasBackend
      ? "backend"
      : hasFrontend
        ? "frontend"
        : "unknown";

  const packageManager = files.some(f => f.relPath === "pnpm-lock.yaml")
    ? "pnpm"
    : files.some(f => f.relPath === "yarn.lock")
      ? "yarn"
      : files.some(f => f.relPath === "package-lock.json")
        ? "npm"
        : undefined;

  const configFiles = files.filter(f => f.kind === "config").map(f => f.relPath);
  const sourceDir = ["src", "app", "pages", "views"].find(dir =>
    fs.existsSync(path.join(root, dir))
  );

  const pageFiles = files.filter(f => f.kind === "page").length;
  const componentFiles = files.filter(f => f.kind === "component").length;
  const apiFiles = files.filter(f => f.kind === "api").length;
  const storeFiles = files.filter(f => f.kind === "store").length;
  const configCount = configFiles.length;
  const codeFiles = files.filter(f =>
    ["code", "api", "store", "permission", "model"].includes(f.kind)
  ).length;

  return {
    name: projectName || pkg.name || path.basename(root),
    path: root,
    type,
    frameworks: frameworks.length > 0 ? frameworks : ["Unknown"],
    packageManager,
    version: pkg.version,
    sourceDir,
    configFiles,
    stats: {
      filesScanned: files.length,
      codeFiles,
      pageFiles,
      componentFiles,
      apiFiles,
      storeFiles,
      configFiles: configCount,
    },
  };
}

// ============ 轻量 JS 对象/括号解析 ============

function findMatching(
  source: string,
  start: number,
  open: string,
  close: string
): number {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findValueEnd(source: string, start: number, end: number): number {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = start; i < end; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) return i;
  }
  return end;
}

export function extractObjectEntries(
  source: string,
  openIndex: number
): Map<string, string> {
  const end = findMatching(source, openIndex, "{", "}");
  const entries = new Map<string, string>();
  if (end === -1) return entries;

  let i = openIndex + 1;
  while (i < end) {
    while (i < end && /[\s,;]/.test(source[i])) i++;
    if (i >= end) break;

    let colon = -1;
    let quote = "";
    let escaped = false;
    let depth = 0;
    for (let j = i; j < end; j++) {
      const ch = source[j];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      else if (ch === "}" || ch === "]" || ch === ")") depth--;
      else if (ch === ":" && depth === 0) {
        colon = j;
        break;
      }
    }
    if (colon === -1) break;

    const key = source
      .slice(i, colon)
      .trim()
      .replace(/^['"`]|['"`]$/g, "")
      .replace(/\s+/g, " ");
    const valueStart = colon + 1;
    const valueEnd = findValueEnd(source, valueStart, end);
    const value = source.slice(valueStart, valueEnd).trim();
    if (key) entries.set(key, value);
    i = valueEnd + 1;
  }

  return entries;
}

function findObjectRanges(source: string): Array<{ start: number; end: number }> {
  const stack: number[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  let quote = "";
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") stack.push(i);
    else if (ch === "}" && stack.length > 0) {
      const start = stack.pop()!;
      ranges.push({ start, end: i });
    }
  }
  return ranges;
}

function cleanString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/['"`]([^'"`]*)['"`]/);
  return (match ? match[1] : value).trim();
}

function resolveComponentPath(
  component: string | undefined,
  routeFile: string,
  root: string
): string | undefined {
  if (!component) return undefined;
  const importMatch = component.match(/import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/);
  const raw = cleanString(importMatch?.[1] || component);
  if (!raw || /^[A-Za-z_$][\w$]*$/.test(raw)) return undefined;

  let abs: string;
  if (raw.startsWith("@/")) {
    abs = path.join(root, "src", raw.slice(2));
  } else if (raw.startsWith("/")) {
    abs = path.join(root, raw.slice(1));
  } else if (raw.startsWith(".")) {
    abs = path.resolve(path.dirname(routeFile), raw);
  } else {
    return undefined;
  }

  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  const extensions = [".vue", ".jsx", ".tsx", ".js", ".ts"];
  for (const ext of extensions) {
    if (fs.existsSync(abs + ext) && fs.statSync(abs + ext).isFile()) return abs + ext;
  }
  for (const ext of extensions) {
    const indexFile = path.join(abs, `index${ext}`);
    if (fs.existsSync(indexFile) && fs.statSync(indexFile).isFile()) return indexFile;
  }
  return undefined;
}

function parseRouteObject(
  content: string,
  range: { start: number; end: number },
  routeFile: string,
  root: string
): RouteDefinition | null {
  const entries = extractObjectEntries(content, range.start);
  const rawPath = cleanString(entries.get("path"));
  if (!rawPath) return null;

  const meta = entries.get("meta");
  let title: string | undefined;
  let permission: string | undefined;
  if (meta?.trim().startsWith("{")) {
    const metaEntries = extractObjectEntries(meta.trim(), 0);
    title = cleanString(metaEntries.get("title"));
    permission = cleanString(
      metaEntries.get("permission") || metaEntries.get("permissions")
    );
  }

  const componentPath = resolveComponentPath(
    entries.get("component"),
    routeFile,
    root
  );
  const pathValue = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const permissions = permission ? [permission] : [];
  return {
    id: stableId("route", pathValue, componentPath || routeFile),
    path: pathValue,
    name: cleanString(entries.get("name")),
    title,
    componentPath,
    filePath: routeFile,
    permissions,
    children: [],
  };
}

export function parseRoutes(root: string, files: ScannedFile[]): RouteDefinition[] {
  const routes: RouteDefinition[] = [];

  for (const file of files.filter(f => f.kind === "route")) {
    const lower = file.relPath.toLowerCase();
    if (file.relPath === "pages.json" || file.relPath.endsWith("/pages.json") || lower.endsWith("/pages.json")) {
      try {
        const json = JSON.parse(file.content) as { pages?: Array<Record<string, unknown>> };
        for (const page of json.pages || []) {
          const rawPath = typeof page.path === "string" ? page.path : "";
          if (!rawPath) continue;
          const style = (page.style || {}) as Record<string, unknown>;
          const title = typeof style.navigationBarTitleText === "string"
            ? style.navigationBarTitleText
            : undefined;
          const normalizedPath = `/${rawPath.replace(/^\//, "")}`;
          const componentPath = path.join(root, rawPath + ".vue");
          routes.push({
            id: stableId("route", normalizedPath, componentPath),
            path: normalizedPath,
            name: rawPath,
            title,
            componentPath: fs.existsSync(componentPath) ? componentPath : undefined,
            filePath: file.relPath,
            permissions: [],
            children: [],
          });
        }
        continue;
      } catch {
        // 继续用通用路由解析
      }
    }

    const ranges = findObjectRanges(file.content);
    const parsed = ranges
      .map(range => parseRouteObject(file.content, range, file.absPath, root))
      .filter((route): route is RouteDefinition => Boolean(route));

    for (const route of parsed) {
      const parent = parsed.find(candidate =>
        candidate !== route &&
        candidate.path !== route.path &&
        candidate.path.endsWith("/") ? false : false
      );
      void parent;
      // Vue Router 子路由通常写成相对 path；通过包含关系还原父路径
      const parentCandidates = parsed.filter(candidate =>
        candidate !== route &&
        rangeContainsRoute(file.content, candidate, route)
      );
      if (parentCandidates.length > 0) {
        const parentRoute = parentCandidates.sort(
          (a, b) => (b.path.length - a.path.length)
        )[0];
        if (!route.path.startsWith("/")) {
          route.path = `${parentRoute.path.replace(/\/+$/, "")}/${route.path.replace(/^\/+/, "")}`;
        }
      }
      routes.push(route);
    }
  }

  const seen = new Set<string>();
  return routes.filter(route => {
    if (seen.has(route.id)) return false;
    seen.add(route.id);
    return true;
  });
}

function rangeContainsRoute(
  content: string,
  parent: RouteDefinition,
  child: RouteDefinition
): boolean {
  const parentIndex = content.indexOf(parent.path);
  const childIndex = content.indexOf(child.path);
  if (parentIndex < 0 || childIndex < 0 || parentIndex >= childIndex) return false;
  const segment = content.slice(parentIndex, childIndex);
  return segment.includes("children") || segment.includes("parent");
}

// ============ 页面解析 ============

function moduleIdFromPath(relPath: string): string {
  const segments = relPath
    .split("/")
    .map(segment => segment.replace(/\.[^.]+$/, ""));
  const relevant = segments.filter(s =>
    !["src", "views", "pages", "components", "api", "store", "stores", "modules", "utils", "index"].includes(s)
  );
  if (relevant.length === 0) return "root";
  return dirSlug(relevant.join("/"));
}

function findRouteForPage(
  file: ScannedFile,
  routes: RouteDefinition[],
  root: string
): RouteDefinition | undefined {
  const exact = routes.find(route => route.componentPath === file.absPath);
  if (exact) return exact;

  let relNoExt = file.relPath.replace(/\.(vue|jsx|tsx|js|ts)$/i, "");
  relNoExt = relNoExt.replace(/^(src\/)?(views|pages)\//, "");
  relNoExt = relNoExt.replace(/(^|\/)index$/, "$1");
  const routePath = `/${relNoExt}`;
  return routes.find(route =>
    route.path.replace(/\/index$/, "") === routePath.replace(/\/index$/, "")
  );
}

function extractAttr(attrs: string, name: string): string | undefined {
  const regex = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = attrs.match(regex);
  return match ? (match[1] || match[2] || match[3]) : undefined;
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueFields(fields: UiField[]): UiField[] {
  const seen = new Set<string>();
  return fields.filter(field => {
    const key = `${field.source}:${field.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseTemplateFields(template: string): {
  queryFields: UiField[];
  formFields: UiField[];
  tableFields: UiField[];
} {
  const queryFields: UiField[] = [];
  const formFields: UiField[] = [];
  const tableFields: UiField[] = [];

  const formMatches = [...template.matchAll(/<(el-form|a-form|uni-forms|van-form)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  const formContent = formMatches.map(m => m[2]).join("\n");

  const formItemRe = /<(el-form-item|a-form-item|uni-forms-item|van-field)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of template.matchAll(formItemRe)) {
    const attrs = match[2];
    const inner = match[3];
    const label = extractAttr(attrs, "label");
    const name = extractAttr(attrs, "prop")
      || extractAttr(attrs, "name")
      || extractAttr(attrs, "field")
      || extractAttr(inner, "v-model")
      || label;
    if (!name) continue;
    const type = inner.includes("date-picker")
      ? "date"
      : inner.includes("select")
        ? "select"
        : extractAttr(inner, "type") || "input";
    formFields.push({
      name,
      label,
      type,
      source: "form",
      required: /required|rules\s*:\s*\[/.test(attrs + inner),
    });
  }

  const tableColRe = /<(el-table-column|a-table-column)\b([^>]*)>/gi;
  for (const match of template.matchAll(tableColRe)) {
    const attrs = match[2];
    const name = extractAttr(attrs, "prop") || extractAttr(attrs, "dataIndex");
    const label = extractAttr(attrs, "label") || extractAttr(attrs, "title");
    if (name) {
      tableFields.push({ name, label, source: "table" });
    }
  }

  const controlRe = /<(el-input|a-input|el-select|a-select|el-date-picker|a-date-picker|input|uni-easyinput|van-field|el-tree-select)\b([^>]*)>/gi;
  for (const match of template.matchAll(controlRe)) {
    const attrs = match[2];
    const model = extractAttr(attrs, "v-model");
    if (!model) continue;
    if (formContent.includes(match[0]) || formFields.some(f => f.name === model)) continue;
    const name = model.includes(".") ? model.split(".").pop()! : model;
    queryFields.push({
      name,
      label: extractAttr(attrs, "placeholder") || extractAttr(attrs, "label") || name,
      type: match[1].includes("date") ? "date" : match[1].includes("select") ? "select" : extractAttr(attrs, "type") || "input",
      source: "query",
    });
  }

  return {
    queryFields: uniqueFields(queryFields),
    formFields: uniqueFields(formFields),
    tableFields: uniqueFields(tableFields),
  };
}

function cleanHandler(value: string): string {
  return value
    .trim()
    .replace(/^\$event\s*[,)]?/, "")
    .split(/[.(]/)[0]
    .trim();
}

function extractPermissionFromTag(tag: string): string | undefined {
  const permissionMatch = tag.match(/(?:v-permission|v-hasPermi)\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (permissionMatch) {
    const raw = permissionMatch[1] || permissionMatch[2] || "";
    const code = raw.match(/['"]([^'"]+)['"]/);
    return code ? code[1] : cleanString(raw);
  }
  const hasPermi = tag.match(/hasPermi\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
  return hasPermi?.[1];
}

function parseTemplateActions(template: string): PageAction[] {
  const actions: PageAction[] = [];
  const seen = new Set<string>();
  const tagPattern = /<([a-zA-Z][\w-]*)\b([^>]*?)@(?:click|tap|submit|confirm)\s*=\s*(?:"([^"]*)"|'([^']*)')([^>]*)>([\s\S]*?)<\/\1>/gi;

  for (const match of template.matchAll(tagPattern)) {
    const tagName = match[1].toLowerCase();
    if (!(tagName === "button" || tagName.includes("button") || tagName.includes("dropdown-item"))) {
      continue;
    }
    const handlerAttr = match[3] || match[4] || "";
    const attrs = `${match[2]} ${match[5]}`;
    const label = stripHtml(match[6]) || extractAttr(attrs, "title") || extractAttr(attrs, "label");
    const handler = cleanHandler(handlerAttr);
    if (!label && !handler) continue;
    const key = `${tagName}:${label}:${handler}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const actionText = label || handler;
    const risk = /删除|移除|撤销|作废|停用|禁用/.test(actionText) ? "destructive" : /查询|搜索|筛选|详情|查看|导出/.test(actionText) ? "read" : "write";
    actions.push({
      id: stableId("page-action", tagName, label, handler),
      label: label || handler || "操作",
      handler: handler || undefined,
      method: handler || undefined,
      apiIds: [],
      permission: extractPermissionFromTag(attrs),
      risk,
    });
  }

  // 自闭合按钮
  const selfClosingRe = /<([a-zA-Z][\w-]*)\b([^>]*?)@(?:click|tap|submit|confirm)\s*=\s*(?:"([^"]*)"|'([^']*)')([^>]*?)\/>/gi;
  for (const match of template.matchAll(selfClosingRe)) {
    const tagName = match[1].toLowerCase();
    if (!(tagName === "button" || tagName.includes("button") || tagName.includes("dropdown-item"))) continue;
    const handlerAttr = match[3] || match[4] || "";
    const attrs = `${match[2]} ${match[5]}`;
    const label = extractAttr(attrs, "label") || extractAttr(attrs, "title");
    const handler = cleanHandler(handlerAttr);
    if (!label && !handler) continue;
    actions.push({
      id: stableId("page-action", tagName, label, handler),
      label: label || handler || "操作",
      handler: handler || undefined,
      method: handler || undefined,
      apiIds: [],
      permission: extractPermissionFromTag(attrs),
      risk: /删除|移除|撤销|作废|停用|禁用/.test(label || handler) ? "destructive" : "write",
    });
  }

  return actions;
}

function extractVueParts(content: string): {
  template: string;
  script: string;
} {
  const templateMatch = content.match(/<template[^>]*>([\s\S]*?)<\/template>/i);
  const scriptMatch = content.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  return {
    template: templateMatch?.[1] || "",
    script: scriptMatch?.[1] || "",
  };
}

function findMethodBody(script: string, handler: string): string {
  const methodName = cleanHandler(handler);
  if (!methodName) return "";
  const patterns = [
    new RegExp(`\\b${methodName}\\s*\\([^)]*\\)\\s*\\{`),
    new RegExp(`\\b${methodName}\\s*:\\s*(?:async\\s*)?function\\s*\\([^)]*\\)\\s*\\{`),
    new RegExp(`\\b${methodName}\\s*:\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`),
  ];
  for (const pattern of patterns) {
    const match = script.match(pattern);
    if (!match || match.index === undefined) continue;
    const openIndex = script.indexOf("{", match.index + match[0].length - 1);
    if (openIndex < 0) continue;
    const endIndex = findMatching(script, openIndex, "{", "}");
    if (endIndex < 0) continue;
    return script.slice(openIndex, endIndex + 1);
  }
  return "";
}

function extractFunctionCallNames(source: string): string[] {
  const names: string[] = [];
  const skipped = new Set([
    "if", "for", "while", "switch", "return", "new", "typeof", "await",
    "function", "import", "export", "catch", "try", "else", "case",
    "yield", "throw", "delete", "void", "in", "of",
  ]);
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of source.matchAll(re)) {
    if (!skipped.has(match[1])) names.push(match[1]);
  }
  return unique(names);
}

function extractPagePurpose(template: string, route: RouteDefinition | undefined): string | undefined {
  const comment = template.match(/<!--([\s\S]*?)-->/);
  const commentText = comment?.[1]?.trim();
  if (commentText) return commentText;
  const heading = template.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  if (heading) return stripHtml(heading[1]);
  return route?.title;
}

export function parsePages(
  files: ScannedFile[],
  routes: RouteDefinition[],
  root: string
): AnalyzedPage[] {
  const pages: AnalyzedPage[] = [];

  for (const file of files.filter(f => f.kind === "page")) {
    const route = findRouteForPage(file, routes, root);
    const { template, script } = extractVueParts(file.content);
    const fields = parseTemplateFields(template);
    const actions = parseTemplateActions(template);
    const moduleId = route
      ? dirSlug(route.path.split("/").filter(Boolean).join("_") || "root")
      : moduleIdFromPath(file.relPath);
    const name = route?.title || route?.name || path.basename(file.relPath, path.extname(file.relPath));
    const page: AnalyzedPage = {
      id: stableId("page", file.relPath),
      name,
      route: route?.path,
      filePath: file.relPath,
      moduleId,
      purpose: extractPagePurpose(template, route),
      queryFields: fields.queryFields,
      tableFields: fields.tableFields,
      formFields: fields.formFields,
      actions,
      states: [],
      permissions: unique([
        ...(route?.permissions || []),
        ...extractPermissionCodes(script),
        ...extractPermissionCodes(template),
      ]),
      apiIds: unique(extractApiCallRefs(script).map(call => stableId("api", call.method, call.path))),
      status: "active",
    };

    for (const action of page.actions) {
      const body = findMethodBody(script, action.handler || "");
      action.calledFunctions = extractFunctionCallNames(body);
      action.apiIds = unique(extractApiCallRefs(body).map(call => stableId("api", call.method, call.path)));
      if (action.apiIds.length === 0 && action.risk !== "read") {
        action.apiIds = page.apiIds;
      }
    }
    pages.push(page);
  }

  return pages;
}

// ============ API 解析 ============

export interface ApiCallRef {
  method: string;
  path: string;
  requestParams: ApiParam[];
  requestBodyKeys: string[];
  offset: number;
}

function splitTopLevel(source: string, delimiter = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let escaped = false;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === delimiter && depth === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function objectKeysFromValue(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{")) {
    const openIndex = 0;
    const entries = extractObjectEntries(trimmed, openIndex);
    return Array.from(entries.keys());
  }
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return [trimmed];
  const spread = trimmed.match(/\.\.\.(\w+)/);
  return spread ? [spread[1]] : [];
}

function parseApiArguments(
  args: string
): { requestParams: ApiParam[]; requestBodyKeys: string[] } {
  const requestParams: ApiParam[] = [];
  const requestBodyKeys: string[] = [];
  const trimmed = args.trim();

  if (trimmed.startsWith("{")) {
    const entries = extractObjectEntries(trimmed, 0);
    for (const [key, value] of entries) {
      if (key === "params" || key === "query") {
        for (const name of objectKeysFromValue(value)) {
          requestParams.push({ name, source: "query" });
        }
      } else if (key === "data" || key === "body") {
        for (const name of objectKeysFromValue(value)) {
          requestBodyKeys.push(name);
          requestParams.push({ name, source: "body" });
        }
      }
    }
  } else {
    const parts = splitTopLevel(trimmed);
    if (parts.length >= 2) {
      const second = parts[1].trim();
      if (second.startsWith("{") && /params\s*:/.test(second)) {
        const entries = extractObjectEntries(second, 0);
        const paramsValue = entries.get("params") || "";
        for (const name of objectKeysFromValue(paramsValue)) {
          requestParams.push({ name, source: "query" });
        }
        const dataValue = entries.get("data") || "";
        for (const name of objectKeysFromValue(dataValue)) {
          requestBodyKeys.push(name);
          requestParams.push({ name, source: "body" });
        }
      } else if (second.startsWith("{")) {
        for (const name of objectKeysFromValue(second)) {
          requestBodyKeys.push(name);
          requestParams.push({ name, source: "body" });
        }
      } else if (/^[A-Za-z_$][\w$]*$/.test(second)) {
        requestBodyKeys.push(second);
        requestParams.push({ name: second, source: "body" });
      }
    }
  }

  return {
    requestParams: Array.from(
      new Map(requestParams.map(param => [`${param.source}:${param.name}`, param])).values()
    ),
    requestBodyKeys: unique(requestBodyKeys),
  };
}

function normalizeApiPath(raw: string): string | null {
  const value = cleanString(raw) || raw.trim();
  if (!value || value.includes("${") || value.includes("+")) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      return new URL(value).pathname;
    } catch {
      return value;
    }
  }
  if (!value.startsWith("/")) return `/${value}`;
  return value;
}

export function extractApiCallRefs(content: string): ApiCallRef[] {
  const refs: ApiCallRef[] = [];
  const seen = new Set<string>();

  const directRe = /(?:axios|request|http|service|client|instance|\$http|\$axios|\$u\.http|ofetch|\$fetch|this\.axios|this\.\$http|this\.\$axios)\s*\.\s*(get|post|put|delete|patch|del)\s*\(\s*(['"`])([^'"`]+)\2/gi;
  for (const match of content.matchAll(directRe)) {
    const method = (match[1].toUpperCase() === "DEL" ? "DELETE" : match[1].toUpperCase());
    const apiPath = normalizeApiPath(match[3]);
    if (!apiPath) continue;
    const openIndex = content.indexOf("(", match.index);
    const closeIndex = openIndex >= 0 ? findMatching(content, openIndex, "(", ")") : -1;
    const args = closeIndex > openIndex ? content.slice(openIndex + 1, closeIndex) : "";
    const key = `${method}:${apiPath}:${match.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      method,
      path: apiPath,
      ...parseApiArguments(args),
      offset: match.index,
    });
  }

  const configRe = /(?:request|axios|http|service|client|\$http|\$axios|uni\.request|this\.\$http|this\.\$axios)\s*\(\s*\{/gi;
  for (const match of content.matchAll(configRe)) {
    const openIndex = content.indexOf("{", match.index + match[0].length - 1);
    if (openIndex < 0) continue;
    const entries = extractObjectEntries(content, openIndex);
    const rawPath = entries.get("url");
    if (!rawPath) continue;
    const apiPath = normalizeApiPath(rawPath);
    if (!apiPath) continue;
    const rawMethod = cleanString(entries.get("method")) || "GET";
    const method = rawMethod.toUpperCase();
    const requestParams: ApiParam[] = [];
    const requestBodyKeys: string[] = [];
    const paramsValue = entries.get("params") || entries.get("query");
    const dataValue = entries.get("data") || entries.get("body");
    if (paramsValue) {
      for (const name of objectKeysFromValue(paramsValue)) {
        requestParams.push({ name, source: "query" });
      }
    }
    if (dataValue) {
      for (const name of objectKeysFromValue(dataValue)) {
        requestBodyKeys.push(name);
        requestParams.push({ name, source: "body" });
      }
    }
    const key = `${method}:${apiPath}:${match.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      method,
      path: apiPath,
      requestParams,
      requestBodyKeys: unique(requestBodyKeys),
      offset: match.index,
    });
  }

  const fetchRe = /(?:fetch|\$fetch|ofetch)\s*\(\s*(['"`])([^'"`]+)\1/gi;
  for (const match of content.matchAll(fetchRe)) {
    const apiPath = normalizeApiPath(match[2]);
    if (!apiPath) continue;
    const openIndex = content.indexOf("(", match.index);
    const closeIndex = openIndex >= 0 ? findMatching(content, openIndex, "(", ")") : -1;
    const args = closeIndex > openIndex ? content.slice(openIndex + 1, closeIndex) : "";
    const methodMatch = args.match(/method\s*:\s*['"]([^'"]+)['"]/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : "GET";
    const key = `${method}:${apiPath}:${match.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      method,
      path: apiPath,
      ...parseApiArguments(args),
      offset: match.index,
    });
  }

  return refs.sort((a, b) => a.offset - b.offset);
}

function extractCallerFunctions(content: string): string[] {
  const names: string[] = [];
  const exportFunction = /export\s+(?:async\s+)?function\s+(\w+)/g;
  for (const match of content.matchAll(exportFunction)) names.push(match[1]);
  const exportConst = /export\s+const\s+(\w+)\s*=\s*(?:async\s*)?(?:function|\()/g;
  for (const match of content.matchAll(exportConst)) names.push(match[1]);
  const methodsMatch = content.match(/methods\s*:\s*\{([\s\S]*?)\}/);
  if (methodsMatch) {
    const objectStart = content.indexOf("{", methodsMatch.index || 0);
    if (objectStart >= 0) {
      for (const name of extractObjectEntries(methodsMatch[0], 0).keys()) {
        names.push(name);
      }
    }
  }
  return unique(names);
}

function detectResponseShape(content: string): ResponseShape | undefined {
  const shape: ResponseShape = {};
  const listMatch = content.match(/\.data\s*\.\s*(list|records|rows|items|result|content)\b/i);
  const objectMatch = content.match(/\.data\s*\.\s*(\w+)\b/i);
  if (/(response|res|resp|result|data)\s*\.\s*data\b/.test(content)) {
    shape.container = "data";
  } else if (/(response|res|resp|result|data)\s*\.\s*(\w+)\b/.test(content)) {
    shape.container = "raw";
  }
  if (listMatch) shape.listField = listMatch[1].toLowerCase();
  if (objectMatch && !listMatch) shape.objectField = objectMatch[1].toLowerCase();
  if (Object.keys(shape).length > 0) return shape;
  return undefined;
}

function apiRisk(method: string, path: string): "read" | "write" | "destructive" {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS") return "read";
  if (upper === "DELETE" || /delete|remove|destroy|cancel|revoke/i.test(path)) return "destructive";
  return "write";
}

export function parseApis(
  files: ScannedFile[],
  root: string,
  pages: AnalyzedPage[]
): ApiDefinition[] {
  const calls = files.flatMap(file =>
    extractApiCallRefs(file.content).map(call => ({ call, file }))
  );
  const grouped = new Map<string, ApiCallRef[]>();
  const sourceByKey = new Map<string, ScannedFile[]>();

  for (const { call, file } of calls) {
    const key = stableId("api", call.method, call.path);
    const list = grouped.get(key) || [];
    list.push(call);
    grouped.set(key, list);
    const sources = sourceByKey.get(key) || [];
    if (!sources.some(s => s.absPath === file.absPath)) sources.push(file);
    sourceByKey.set(key, sources);
  }

  const apis: ApiDefinition[] = [];
  for (const [key, refs] of grouped) {
    const first = refs[0];
    const sourceFiles = sourceByKey.get(key) || [];
    const moduleId = moduleIdFromPath(sourceFiles[0]?.relPath || "root");
    const requestParams = Array.from(
      new Map(
        refs.flatMap(ref => ref.requestParams).map(param => [`${param.source}:${param.name}`, param])
      ).values()
    );
    const requestBodyKeys = unique(refs.flatMap(ref => ref.requestBodyKeys));
    const pageIds = pages
      .filter(page =>
        sourceFiles.some(file => file.absPath === path.join(root, page.filePath)) ||
        page.apiIds.includes(key)
      )
      .map(page => page.id);
    const permissionCandidates = sourceFiles.flatMap(file =>
      extractPermissionCodes(file.content)
    );
    const callerFunctions = unique(
      sourceFiles.flatMap(file => extractCallerFunctions(file.content))
    );
    const responseShape = sourceFiles
      .map(file => detectResponseShape(file.content))
      .find(Boolean);

    apis.push({
      id: key,
      method: first.method,
      path: first.path,
      moduleId,
      sourceFiles: sourceFiles.map(file => file.relPath),
      callerFunctions,
      pageIds,
      requestParams,
      requestBodyKeys,
      responseShape,
      description: `${first.method} ${first.path}`,
      permission: permissionCandidates[0],
      risk: apiRisk(first.method, first.path),
      status: "active",
    });
  }

  return apis.sort((a, b) => a.moduleId.localeCompare(b.moduleId) || a.path.localeCompare(b.path));
}

// ============ Store / 实体 / 权限 / 状态 ============

export function parseStoreModules(files: ScannedFile[]): StoreModuleInfo[] {
  const stores: StoreModuleInfo[] = [];
  for (const file of files.filter(f => f.kind === "store")) {
    const defineStore = file.content.match(/defineStore\s*\(\s*['"]([^'"]+)['"]/);
    const name = defineStore?.[1]
      || path.basename(file.relPath, path.extname(file.relPath))
      || "store";
    const moduleId = moduleIdFromPath(file.relPath);
    const stateFields: string[] = [];
    const stateRe = /state\s*:\s*(?:\(\)\s*=>\s*)?(?:\(\s*)?\{([\s\S]*?)\}\s*\)?/g;
    for (const match of file.content.matchAll(stateRe)) {
      const openIndex = file.content.indexOf("{", match.index || 0);
      if (openIndex >= 0) {
        for (const key of extractObjectEntries(file.content, openIndex).keys()) {
          stateFields.push(key);
        }
      }
    }
    const actions: string[] = [];
    const actionsMatch = file.content.match(/actions\s*:\s*\{([\s\S]*?)\}/);
    if (actionsMatch) {
      const openIndex = file.content.indexOf("{", actionsMatch.index || 0);
      if (openIndex >= 0) {
        for (const key of extractObjectEntries(file.content, openIndex).keys()) {
          actions.push(key);
        }
      }
    }
    const topFunctions = /(?:async\s+)?function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?(?:function|\()/g;
    for (const match of file.content.matchAll(topFunctions)) {
      actions.push(match[1] || match[2] || "");
    }
    stores.push({
      id: stableId("store", moduleId, name),
      name,
      filePath: file.relPath,
      moduleId,
      stateFields: unique(stateFields),
      actions: unique(actions.filter(Boolean)),
    });
  }
  return stores;
}

export function parseEntities(files: ScannedFile[]): EntityDefinition[] {
  const entities = new Map<string, EntityDefinition>();

  for (const file of files) {
    const moduleId = moduleIdFromPath(file.relPath);
    const interfaceRe = /interface\s+(\w+)[^\{]*\{([^}]*)\}/g;
    for (const match of file.content.matchAll(interfaceRe)) {
      const name = match[1];
      const fields = parseEntityFields(match[2]);
      mergeEntity(entities, {
        id: stableId("entity", name),
        name,
        moduleId,
        sourceFiles: [file.relPath],
        fields,
        source: "interface",
        description: `Interface ${name}`,
        status: "active",
      });
    }

    const typeRe = /type\s+(\w+)\s*=\s*\{([^}]*)\}/g;
    for (const match of file.content.matchAll(typeRe)) {
      const name = match[1];
      const fields = parseEntityFields(match[2]);
      mergeEntity(entities, {
        id: stableId("entity", name),
        name,
        moduleId,
        sourceFiles: [file.relPath],
        fields,
        source: "interface",
        description: `Type ${name}`,
        status: "active",
      });
    }

    const formRe = /(?:const|let|var|this\.)\s*(form|query|searchForm|model)\s*[:=]\s*\{([\s\S]*?)\}/g;
    for (const match of file.content.matchAll(formRe)) {
      const name = match[1];
      const raw = match[2];
      if (raw.length > 4000) continue;
      const entries = extractObjectEntries(raw, 0);
      const fields = Array.from(entries.entries()).map(([fieldName, value]) => ({
        name: fieldName,
        type: value.includes(":") ? "object" : undefined,
      }));
      mergeEntity(entities, {
        id: stableId("entity", `${name}_form`),
        name: `${name}_form`,
        moduleId,
        sourceFiles: [file.relPath],
        fields,
        source: "form",
        description: `${name} 表单模型`,
        status: "active",
      });
    }
  }

  return Array.from(entities.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function parseEntityFields(body: string): EntityField[] {
  const fields: EntityField[] = [];
  const re = /^\s*(\w+)\??\s*:\s*([^;\n]+)/gm;
  for (const match of body.matchAll(re)) {
    const type = match[2].trim().split(/\s*[=,]/)[0].trim();
    fields.push({
      name: match[1],
      type,
      required: !match[0].includes("?"),
    });
  }
  return fields;
}

function mergeEntity(
  map: Map<string, EntityDefinition>,
  entity: EntityDefinition
): void {
  const existing = map.get(entity.id);
  if (!existing) {
    map.set(entity.id, entity);
    return;
  }
  existing.sourceFiles = unique([...existing.sourceFiles, ...entity.sourceFiles]);
  const fieldMap = new Map(existing.fields.map(field => [field.name, field]));
  for (const field of entity.fields) {
    if (!fieldMap.has(field.name)) fieldMap.set(field.name, field);
  }
  existing.fields = Array.from(fieldMap.values());
  if (entity.source === "interface" && existing.source !== "interface") {
    existing.source = "interface";
  }
}

export function extractPermissionCodes(content: string): string[] {
  const codes: string[] = [];
  const lineRe = /^.*?(?:permission|perms|hasPermi|hasPermission|v-hasPermi|v-permission|roles?|menu).*$/gim;
  for (const line of content.matchAll(lineRe)) {
    const stringRe = /['"]([a-zA-Z0-9_\-:./\u4e00-\u9fa5]{2,})['"]/g;
    for (const match of line[0].matchAll(stringRe)) {
      const value = match[1];
      if (/(token|password|secret)/i.test(value)) continue;
      codes.push(value);
    }
  }
  return unique(codes);
}

function permissionType(content: string): PermissionType {
  if (/login|logout|authenticate|authCode/i.test(content)) return "login";
  if (/dataScope|dataPermission|data_scope|数据权限/i.test(content)) return "data";
  if (/roles?\s*[:=]|roleId|role_id|角色/i.test(content)) return "role";
  if (/menuId|menu_id|菜单/i.test(content)) return "menu";
  if (/session|sessionId|session_id/i.test(content)) return "session";
  if (/currentUser|userInfo|userId|user_id|当前用户/i.test(content)) return "user";
  if (/token|Authorization|Bearer/i.test(content)) return "token";
  if (/hasPermi|v-hasPermi|v-permission|buttonPerm|按钮权限/i.test(content)) return "button";
  return "other";
}

export function parsePermissions(
  files: ScannedFile[],
  pages: AnalyzedPage[]
): PermissionDefinition[] {
  const map = new Map<string, PermissionDefinition>();
  for (const file of files) {
    const codes = extractPermissionCodes(file.content);
    const type = permissionType(file.content);
    const expressions = codes.length > 0 ? codes : [];
    const names = expressions.length > 0
      ? expressions
      : type === "login"
        ? ["登录认证"]
        : type === "token"
          ? ["Token 认证"]
          : ["权限配置"];
    const confidence = expressions.length > 0
      ? "high"
      : type === "other"
        ? "low"
        : "medium";
    for (const name of names) {
      const id = stableId("permission", type, name);
      const existing = map.get(id);
      const pageIds = pages
        .filter(page => page.filePath === file.relPath || page.permissions.includes(name))
        .map(page => page.id);
      if (existing) {
        existing.sourceFiles = unique([...existing.sourceFiles, file.relPath]);
        existing.expressions = unique([...existing.expressions, ...expressions]);
        existing.pageIds = unique([...existing.pageIds, ...pageIds]);
      } else {
        map.set(id, {
          id,
          name,
          type,
          confidence,
          sourceFiles: [file.relPath],
          expressions,
          pageIds,
          apiIds: [],
          description: `${type} 权限：${name}`,
          status: "active",
        });
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => a.type.localeCompare(b.type));
}

function stateLabelFromEntries(entries: Map<string, string>): string | undefined {
  return cleanString(entries.get("label"))
    || cleanString(entries.get("text"))
    || cleanString(entries.get("name"));
}

export function parseStates(files: ScannedFile[]): StateDefinition[] {
  const states = new Map<string, StateDefinition>();
  for (const file of files) {
    const moduleId = moduleIdFromPath(file.relPath);
    const arrayRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]\s*\[([\s\S]*?)\]\s*;?/g;
    for (const match of file.content.matchAll(arrayRe)) {
      if (!/status|state|dict|option/i.test(match[1])) continue;
      const rawArray = match[2];
      if (rawArray.length > 6000) continue;
      for (const range of findObjectRanges(`{${rawArray}}`)) {
        const entries = extractObjectEntries(`{${rawArray}}`, range.start);
        const label = stateLabelFromEntries(entries);
        const value = cleanString(entries.get("value")) || entries.get("value")?.trim();
        if (!label || value === undefined) continue;
        const id = stableId("state", moduleId, label, value);
        mergeState(states, {
          id,
          name: toSlug(label) || label,
          label,
          value: String(value),
          moduleId,
          sourceFiles: [file.relPath],
          allowedOperations: [],
          description: `状态 ${label}`,
          status: "active",
        });
      }
    }

    const mapRe = /([A-Za-z_$][\w$]*)\s*[:=]\s*\{([\s\S]*?)\}\s*;?/g;
    for (const match of file.content.matchAll(mapRe)) {
      if (!/statusMap|stateMap|statusText|stateText|statusList|dictStatus/i.test(match[1])) continue;
      const raw = match[2];
      if (raw.length > 6000) continue;
      const entries = extractObjectEntries(raw, 0);
      for (const [value, rawLabel] of entries) {
        const label = cleanString(rawLabel) || rawLabel;
        if (!label) continue;
        const id = stableId("state", moduleId, label, value);
        mergeState(states, {
          id,
          name: toSlug(label) || label,
          label,
          value,
          moduleId,
          sourceFiles: [file.relPath],
          allowedOperations: [],
          description: `状态 ${label}`,
          status: "active",
        });
      }
    }
  }
  return Array.from(states.values()).sort(
    (a, b) => a.moduleId.localeCompare(b.moduleId) || a.label.localeCompare(b.label, "zh-CN")
  );
}

function mergeState(
  map: Map<string, StateDefinition>,
  state: StateDefinition
): void {
  const existing = map.get(state.id);
  if (!existing) {
    map.set(state.id, state);
    return;
  }
  existing.sourceFiles = unique([...existing.sourceFiles, ...state.sourceFiles]);
  existing.allowedOperations = unique([
    ...existing.allowedOperations,
    ...state.allowedOperations,
  ]);
}

export function buildModules(
  files: ScannedFile[],
  pages: AnalyzedPage[],
  apis: ApiDefinition[],
  entities: EntityDefinition[],
  states: StateDefinition[],
  stores: StoreModuleInfo[]
): AnalyzedModule[] {
  const ids = unique([...pages.map(p => p.moduleId), ...apis.map(a => a.moduleId), ...entities.map(e => e.moduleId), ...states.map(s => s.moduleId), ...stores.map(s => s.moduleId)]);
  return ids.map(id => {
    const name = id.replace(/_/g, " ").replace(/\b\w/g, char => char.toUpperCase());
    const modulePages = pages.filter(p => p.moduleId === id);
    const moduleApis = apis.filter(a => a.moduleId === id);
    const moduleStores = stores.filter(s => s.moduleId === id);
    const moduleEntities = entities.filter(e => e.moduleId === id);
    const moduleStates = states.filter(s => s.moduleId === id);
    return {
      id,
      name,
      path: id,
      pageIds: modulePages.map(p => p.id),
      apiIds: moduleApis.map(a => a.id),
      entityIds: moduleEntities.map(e => e.id),
      stateIds: moduleStates.map(s => s.id),
      storeFiles: moduleStores.map(s => s.filePath),
      stateFields: unique(moduleStores.flatMap(s => s.stateFields)),
      actions: unique(moduleStores.flatMap(s => s.actions)),
      permissions: unique(modulePages.flatMap(p => p.permissions)),
      status: "active",
    };
  });
}
