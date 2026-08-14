const state = {
  projects: [],
  project: null,
  query: "",
  searchResults: [],
  searchActive: false,
  selectedProjectName: null,
  pendingFocusId: null,
};

const els = {
  projectList: document.getElementById("projectList"),
  content: document.getElementById("content"),
  searchInput: document.getElementById("searchInput"),
  clearSearch: document.getElementById("clearSearch"),
  searchStatus: document.getElementById("searchStatus"),
  refreshButton: document.getElementById("refreshButton"),
  sidebarToggle: document.getElementById("sidebarToggle"),
};

const categoryLabels = {
  architecture: "架构设计",
  feature: "功能实现",
  pattern: "设计模式",
  api: "API接口",
  data_flow: "数据流",
  bug_fix: "Bug修复",
  performance: "性能优化",
  config: "配置相关",
  dependency: "依赖相关",
  other: "其他",
};

const statusLabels = {
  active: "有效",
  stale: "可能过期",
  invalidated: "已失效",
};

const confidenceLabels = {
  high: "高置信",
  medium: "中置信",
  low: "低置信",
};

const icons = {
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  fileText: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
  chevronLeft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
  chevronRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
};

const SIDEBAR_STORAGE_KEY = "project-analysis.sidebarCollapsed";

function setSidebarCollapsed(collapsed, persist = true) {
  const sidebar = document.querySelector(".sidebar");
  sidebar.classList.toggle("collapsed", collapsed);
  els.sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  els.sidebarToggle.title = collapsed ? "展开侧栏" : "收起侧栏";
  els.sidebarToggle.innerHTML = collapsed ? icons.chevronRight : icons.chevronLeft;

  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
    } catch (error) {
      // Storage may be unavailable in privacy mode; the in-memory state still works.
    }
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function highlight(value, query) {
  const escaped = escapeHtml(value);
  const tokens = String(query || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegExp);

  if (!tokens.length) return escaped;
  const pattern = tokens.join("|");
  return escaped.replace(new RegExp(`(${pattern})`, "gi"), "<mark>$1</mark>");
}

function renderEmpty() {
  els.searchStatus.textContent = "";
  els.content.innerHTML = `<div class="empty-state">${
    state.projects.length ? "未选择项目" : "暂无项目"
  }</div>`;
}

function renderError(message) {
  els.searchStatus.textContent = "";
  els.content.innerHTML = `<div class="error-state">${escapeHtml(message)}</div>`;
}

function renderProjectList() {
  if (!state.projects.length) {
    els.projectList.innerHTML = `<div class="sidebar-empty">暂无项目</div>`;
    return;
  }

  els.projectList.innerHTML = state.projects
    .map((project) => {
      const active = project.name === state.selectedProjectName ? " active" : "";
      const projectInitial = Array.from(String(project.name).trim())[0] || "?";
      return `
        <button class="project-item${active}" data-project="${escapeHtml(project.name)}" title="${escapeHtml(project.name)}" type="button">
          <div class="project-item-top">
            <span class="project-initial">${escapeHtml(projectInitial)}</span>
            <span class="project-icon">${icons.folder}</span>
            <span class="project-name">${escapeHtml(project.name)}</span>
          </div>
          <div class="project-item-meta">
            <span>${project.insightCount || 0} 条洞察</span>
            <span>${formatDate(project.lastUpdated)}</span>
          </div>
        </button>
      `;
    })
    .join("");
}

function calculateStats(project) {
  const categoryCounts = {};
  const statusCounts = {};

  for (const insight of project.insights || []) {
    const category = insight.category || "other";
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    const status = insight.status || "active";
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }

  return { categoryCounts, statusCounts };
}

function renderDetails(insight) {
  const groups = [];

  if ((insight.relatedFiles || []).length) {
    groups.push({ label: "文件", values: insight.relatedFiles });
  }
  if ((insight.relatedSymbols || []).length) {
    groups.push({ label: "符号", values: insight.relatedSymbols });
  }
  if ((insight.relatedModules || []).length) {
    groups.push({ label: "模块", values: insight.relatedModules });
  }
  if ((insight.relatedApis || []).length) {
    groups.push({ label: "API", values: insight.relatedApis });
  }

  if (!groups.length) return "";

  const body = groups
    .map(
      (group) => `
        <div class="detail-line">
          <span class="detail-label">${escapeHtml(group.label)}</span>
          <span class="detail-value">${group.values
            .map((value) => escapeHtml(value))
            .join("<br>")}</span>
        </div>
      `
    )
    .join("");

  return `<details class="insight-details"><summary>关联信息</summary>${body}</details>`;
}

function renderInsightCard(insight) {
  const category = categoryLabels[insight.category] || insight.category || "其他";
  const status = statusLabels[insight.status] || statusLabels.active;
  const statusClass = ["active", "stale", "invalidated"].includes(insight.status)
    ? insight.status
    : "active";
  const version = insight.version || 1;
  const confidence = confidenceLabels[insight.confidence] || insight.confidence || "-";
  const snapshotCount = (insight.fileSnapshots || []).length;
  const tags = (insight.tags || [])
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join("");

  return `
    <article class="insight-card" id="insight-${escapeHtml(insight.id)}">
      <div class="insight-head">
        <div class="insight-question">
          ${icons.fileText}
          <h3>${escapeHtml(insight.question || "未命名洞察")}</h3>
        </div>
        <div class="insight-badges">
          <span class="badge category">${escapeHtml(category)}</span>
          <span class="badge status-${statusClass}">${escapeHtml(status)}</span>
        </div>
      </div>
      <div class="insight-answer">${escapeHtml(insight.answer || "")}</div>
      <div class="insight-meta">v${version} · ${escapeHtml(confidence)} · ${formatDateTime(insight.recordedAt)} · 快照 ${snapshotCount}</div>
      ${tags ? `<div class="tag-row">${tags}</div>` : ""}
      ${renderDetails(insight)}
    </article>
  `;
}

function renderProjectDetail() {
  const project = state.project;
  if (!project) {
    renderEmpty();
    return;
  }

  const insights = [...(project.insights || [])].sort((a, b) =>
    String(b.recordedAt).localeCompare(String(a.recordedAt))
  );
  const stats = calculateStats(project);
  const categoryChips = Object.entries(stats.categoryCounts)
    .map(
      ([category, count]) =>
        `<span class="stat-chip">${escapeHtml(categoryLabels[category] || category)} ${count}</span>`
    )
    .join("");

  els.searchStatus.textContent = "";
  els.content.innerHTML = `
    <section class="project-heading">
      <div class="project-title-row">
        <h1>${escapeHtml(project.name)}</h1>
        <span class="schema-badge">Schema v${escapeHtml(project.schemaVersion || 1)}</span>
      </div>
      <div class="project-path">${escapeHtml(project.projectPath || "")}</div>
      <div class="project-stats">
        <span class="stat-chip">${insights.length} 条洞察</span>
        <span class="stat-chip">创建 ${formatDate(project.createdAt)}</span>
        <span class="stat-chip">更新 ${formatDate(project.lastUpdated)}</span>
        ${categoryChips}
      </div>
    </section>
    <section class="summary-panel">
      <h2>业务总结</h2>
      <p class="summary-text">${escapeHtml(project.businessSummary || "暂无业务总结")}</p>
    </section>
    <section>
      <div class="section-heading">
        <h2>洞察沉淀</h2>
        <span>${insights.length} 条</span>
      </div>
      ${insights.map(renderInsightCard).join("")}
    </section>
  `;
}

function groupSearchResults(results) {
  const groups = new Map();
  for (const result of results) {
    const list = groups.get(result.projectName) || [];
    list.push(result);
    groups.set(result.projectName, list);
  }
  return groups;
}

function renderSearchHit(result) {
  const title =
    result.kind === "project" ? "业务总结" : result.insight?.question || "洞察";
  const body =
    result.kind === "project"
      ? state.projects.find((project) => project.name === result.projectName)
          ?.businessSummary || ""
      : result.insight?.answer || "";
  const fields = (result.matchedFields || []).join("、");

  return `
    <button class="search-hit" data-project="${escapeHtml(result.projectName)}" data-insight="${escapeHtml(result.insight?.id || "")}" type="button">
      <div class="search-hit-title">${highlight(title, state.query)}</div>
      <div class="search-hit-meta">${escapeHtml(fields)} · ${escapeHtml(result.projectName)}</div>
      ${body ? `<div class="search-hit-answer">${highlight(body, state.query)}</div>` : ""}
    </button>
  `;
}

function renderSearchResults(data) {
  state.searchResults = data.results || [];
  els.searchStatus.textContent = `${state.searchResults.length} 条匹配`;

  if (!state.searchResults.length) {
    els.content.innerHTML = `<div class="empty-state">没有匹配结果</div>`;
    return;
  }

  const groups = groupSearchResults(state.searchResults);
  const groupHtml = Array.from(groups.entries())
    .map(
      ([projectName, results]) => `
        <section class="search-group">
          <button class="search-project" data-project="${escapeHtml(projectName)}" type="button">
            ${icons.folder}
            <span>${escapeHtml(projectName)}</span>
            <span class="search-project-count">${results.length} 条</span>
          </button>
          ${results.map(renderSearchHit).join("")}
        </section>
      `
    )
    .join("");

  els.content.innerHTML = `
    <section class="search-title">
      <h1>搜索结果</h1>
      <p>“${escapeHtml(state.query)}” 共 ${state.searchResults.length} 条</p>
    </section>
    ${groupHtml}
  `;
}

function focusInsight(insightId) {
  if (!insightId) return;
  const card = document.getElementById(`insight-${escapeHtml(insightId)}`);
  if (!card) return;
  card.classList.add("flash");
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => card.classList.remove("flash"), 2000);
}

async function loadProject(name) {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error("project load failed");
    const data = await response.json();
    state.project = data.project;
    renderProjectDetail();

    if (state.pendingFocusId) {
      focusInsight(state.pendingFocusId);
      state.pendingFocusId = null;
    }
  } catch (error) {
    renderError("无法加载项目知识");
  }
}

async function selectProject(name, insightId = null) {
  state.selectedProjectName = name;
  state.searchActive = false;
  state.query = "";
  state.pendingFocusId = insightId;
  els.searchInput.value = "";
  els.clearSearch.classList.remove("visible");
  renderProjectList();
  await loadProject(name);
}

async function loadProjects() {
  try {
    const response = await fetch("/api/projects");
    if (!response.ok) throw new Error("projects load failed");
    const data = await response.json();
    state.projects = data.projects || [];
    renderProjectList();

    if (!state.selectedProjectName && state.projects.length) {
      await selectProject(state.projects[0].name);
    } else if (state.selectedProjectName) {
      await loadProject(state.selectedProjectName);
    } else {
      renderEmpty();
    }
  } catch (error) {
    renderError("无法加载项目列表");
  }
}

let searchTimer = null;
let searchRequestId = 0;

async function runSearch(rawQuery) {
  const query = rawQuery.trim();
  state.query = query;

  if (!query) {
    state.searchActive = false;
    renderCurrentView();
    return;
  }

  state.searchActive = true;
  els.searchStatus.textContent = "搜索中...";
  const requestId = ++searchRequestId;

  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error("search failed");
    const data = await response.json();
    if (requestId !== searchRequestId) return;
    renderSearchResults(data);
  } catch (error) {
    if (requestId !== searchRequestId) return;
    renderError("搜索失败");
  }
}

function renderCurrentView() {
  if (state.searchActive && state.query) {
    renderSearchResults({
      query: state.query,
      results: state.searchResults,
    });
  } else if (state.project) {
    renderProjectDetail();
  } else {
    renderEmpty();
  }
}

let refreshSpinTimer = null;

function triggerRefreshSpin() {
  els.refreshButton.classList.remove("spinning");
  void els.refreshButton.offsetWidth;
  els.refreshButton.classList.add("spinning");
  window.clearTimeout(refreshSpinTimer);
  refreshSpinTimer = window.setTimeout(() => {
    els.refreshButton.classList.remove("spinning");
  }, 700);
}

function bindEvents() {
  els.projectList.addEventListener("click", (event) => {
    const item = event.target.closest("[data-project]");
    if (item) selectProject(item.dataset.project);
  });

  els.content.addEventListener("click", (event) => {
    const item = event.target.closest("[data-project]");
    if (!item) return;
    const insightId = item.dataset.insight || null;
    selectProject(item.dataset.project, insightId);
  });

  els.searchInput.addEventListener("input", () => {
    const value = els.searchInput.value;
    els.clearSearch.classList.toggle("visible", value.length > 0);
    window.clearTimeout(searchTimer);

    if (!value.trim()) {
      state.searchActive = false;
      state.query = "";
      renderCurrentView();
      return;
    }

    searchTimer = window.setTimeout(() => runSearch(value), 180);
  });

  els.searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    window.clearTimeout(searchTimer);
    runSearch(els.searchInput.value);
  });

  els.clearSearch.addEventListener("click", () => {
    els.searchInput.value = "";
    els.clearSearch.classList.remove("visible");
    state.searchActive = false;
    state.query = "";
    renderCurrentView();
    els.searchInput.focus();
  });

  els.sidebarToggle.addEventListener("click", () => {
    const sidebar = document.querySelector(".sidebar");
    setSidebarCollapsed(!sidebar.classList.contains("collapsed"));
  });

  els.refreshButton.addEventListener("click", async () => {
    triggerRefreshSpin();
    await loadProjects();
  });
}

function init() {
  bindEvents();
  try {
    setSidebarCollapsed(
      localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1",
      false
    );
  } catch (error) {
    // Keep the default expanded state when storage is unavailable.
  }
  loadProjects();
}

document.addEventListener("DOMContentLoaded", init);
