const state = {
  projects: [],
  projectName: null,
  sessionId: null,
  sessions: [],
  config: null,
  sending: false,
  toolLabels: {},
};

const els = {
  projectSelect: document.getElementById("projectSelect"),
  newSessionButton: document.getElementById("newSessionButton"),
  configButton: document.getElementById("configButton"),
  chatLog: document.getElementById("chatLog"),
  confirmationPanel: document.getElementById("confirmationPanel"),
  chatForm: document.getElementById("chatForm"),
  messageInput: document.getElementById("messageInput"),
  sendButton: document.getElementById("sendButton"),
  sessionList: document.getElementById("sessionList"),
  logList: document.getElementById("logList"),
  sessionStatus: document.getElementById("sessionStatus"),
  refreshHistoryButton: document.getElementById("refreshHistoryButton"),
  configModal: document.getElementById("configModal"),
  closeConfigButton: document.getElementById("closeConfigButton"),
  configForm: document.getElementById("configForm"),
  toast: document.getElementById("toast"),
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function humanizeToolName(name) {
  const labels = {
    query: "查询",
    get: "查询",
    list: "列表",
    save: "新增",
    update: "修改",
    delete: "删除",
    review: "复核",
    run: "执行",
    recognize: "识别",
    source: "溯源",
    standard: "标准",
    device: "设备",
    page: "分页",
    detail: "详情",
    cert: "证书",
    plant: "设备",
    process: "处理",
    file: "文件",
    info: "信息",
    link: "链路",
    check: "核查",
    stat: "统计",
    org: "单位",
    dict: "字典",
    result: "结果",
    trace: "溯源",
    chain: "链路",
  };
  return String(name || "业务操作")
    .split("_")
    .filter(Boolean)
    .map(word => labels[word] || word)
    .join(" ");
}

const columnLabels = {
  provinceName: "省份",
  plantNo: "设备编号",
  productNo: "出厂编号",
  plantName: "设备名称",
  stanPlantTypeName: "器具分类",
  standardNo: "标准编号",
  standardName: "标准名称",
  producter: "生产厂家",
  plantModel: "型号/规格",
  measRange: "测量范围",
  accuracyLevel: "准确度/不确定度",
  sourceCycle: "溯源周期(月)",
  commDate: "投运时间",
  stopDate: "停用时间",
  lastSourceDate: "最近溯源时间",
  useUnit: "使用单位",
  manageUnit: "管理单位",
  standardMajorName: "标准专业",
  standardClassName: "标准类别",
  standardStateName: "标准状态",
  consUnitName: "建标单位名称",
  consUnitLevelName: "建标机构级别",
  consUnitTypeName: "建标单位类型",
  measuringRange: "测量范围",
  reviewCycle: "复查周期(月)",
  storageLocation: "保存地点",
  creStandDate: "建标日期",
  createUser: "创建人",
  createTime: "创建时间",
  certNo: "证书编号",
  certType: "证书类型",
  sourceOrg: "证书出具单位",
  sourceDate: "校准/检定日期",
  sourceValidDate: "有效期至",
  conclusionName: "结论",
  applicant: "送检/客户单位",
  receiptDate: "接收日期",
  issueDate: "签发日期",
  authUser: "批准人",
  verifyUser: "核验人",
  caliUser: "校准人",
  docimUser: "检定人",
  resultTypeName: "结果类型",
  errNode: "异常节点",
  errRemark: "判定说明",
  pageNum: "页码",
  pageSize: "每页条数",
  total: "总记录数",
  totalPage: "总页数",
};

function getColumnLabel(column) {
  return columnLabels[column] || String(column || "").replace(/([A-Z])/g, " $1").replace(/_/g, " ");
}

function getToolLabel(name) {
  return state.toolLabels[name] || humanizeToolName(name);
}

async function loadToolLabels(projectName) {
  if (!projectName) return;
  try {
    const data = await apiFetch(`/api/projects/${encodeURIComponent(projectName)}/tools`);
    state.toolLabels = Object.fromEntries(
      (data.tools || []).map(tool => [tool.name, tool.businessPurpose || tool.name])
    );
  } catch (error) {
    state.toolLabels = {};
  }
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.remove("visible"), 3200);
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    headers: options.body ? { "Content-Type": "application/json" } : {},
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `请求失败 (${response.status})`);
  }
  return data;
}

function renderProjectSelect() {
  els.projectSelect.innerHTML = [
    `<option value="">选择项目</option>`,
    ...state.projects.map(project =>
      `<option value="${escapeHtml(project.name)}">${escapeHtml(project.name)}</option>`
    ),
  ].join("");
  if (state.projectName) els.projectSelect.value = state.projectName;
}

function renderSessionList() {
  if (state.sessions.length === 0) {
    els.sessionList.innerHTML = `<div class="ai-empty">暂无历史会话</div>`;
    return;
  }
  els.sessionList.innerHTML = state.sessions
    .filter(session => !state.projectName || session.projectName === state.projectName)
    .slice(0, 50)
    .map(session => `
      <button class="ai-session-item${session.id === state.sessionId ? " active" : ""}" data-session="${escapeHtml(session.id)}" type="button">
        <div>${escapeHtml(session.projectName)}</div>
        <small>${escapeHtml(session.id)} · ${formatTime(session.updatedAt)} · ${session.messages.length} 条</small>
      </button>
    `)
    .join("");
}

function appendMessage(role, content, extra = "") {
  const className = role === "user"
    ? "ai-message ai-message-user"
    : role === "error"
      ? "ai-message ai-message-error"
      : "ai-message ai-message-agent";
  const node = document.createElement("div");
  node.className = className;
  node.innerHTML = `${escapeHtml(content)}${extra}`;
  els.chatLog.appendChild(node);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
  return node;
}

function appendThinking() {
  const node = document.createElement("div");
  node.className = "ai-thinking";
  node.textContent = "正在处理...";
  els.chatLog.appendChild(node);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
  return node;
}

function extractRows(data) {
  function findRows(value, depth = 0) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object" || depth > 5) return null;
    for (const key of ["list", "records", "rows", "items", "data", "content"]) {
      const found = findRows(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  }
  return findRows(data);
}

function renderResultTable(result) {
  const rows = extractRows(result?.data);
  if (!rows || rows.length === 0) {
    return `<div class="ai-tool-message">未返回表格数据</div>`;
  }
  const columns = Array.from(new Set(rows.flatMap(row => Object.keys(row || {})))).slice(0, 12);
  const head = columns.map(column => `<th>${escapeHtml(getColumnLabel(column))}</th>`).join("");
  const body = rows.slice(0, 50).map(row =>
    `<tr>${columns.map(column => `<td>${escapeHtml(String(row?.[column] ?? ""))}</td>`).join("")}</tr>`
  ).join("");
  return `<div class="ai-result-table-wrap"><table class="ai-result-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table><div class="ai-result-count">共 ${rows.length} 行，当前展示前 ${Math.min(50, rows.length)} 行</div></div>`;
}

function toolCard(entry) {
  const result = entry.result || {};
  const rows = extractRows(result?.data);
  if (!rows || rows.length === 0) return "";
  const status = result.success === false ? "失败" : "成功";
  const statusClass = result.success === false ? "ai-badge-error" : "";
  const resultBody = renderResultTable(result);
  return `
    <div class="ai-tool-card">
      <div class="ai-tool-head">
        <span class="ai-tool-name">${escapeHtml(getToolLabel(entry.toolName))}</span>
        <span class="ai-badge ${statusClass}">${status}</span>
      </div>
      <div class="ai-tool-body">
        ${resultBody}
      </div>
    </div>
  `;
}

function renderToolResults(result) {
  if (!result.toolResults || result.toolResults.length === 0) return "";
  return result.toolResults.map(toolCard).join("");
}

function renderPendingParams(pending) {
  if (!pending) return "";
  const name = getToolLabel(pending.toolName || pending.workflowName || "");
  const args = pending.arguments || {};
  const missing = (pending.missingInputs || []).map(item => `<span class="ai-badge ai-badge-error">${escapeHtml(item)}</span>`).join(" ");
  return `
    <div class="ai-tool-card">
      <div class="ai-tool-head"><span class="ai-tool-name">${escapeHtml(name)}</span></div>
      <div class="ai-tool-body">
        <pre class="ai-params">${escapeHtml(JSON.stringify(args, null, 2))}</pre>
        ${missing ? `<div>需要补充：${missing}</div>` : ""}
      </div>
    </div>
  `;
}

function renderConfirmation(result) {
  if (!result.confirmationRequest && !result.pendingAction?.confirm) {
    els.confirmationPanel.hidden = true;
    els.confirmationPanel.innerHTML = "";
    return;
  }
  const pending = result.pendingAction || {};
  const name = getToolLabel(pending.toolName || pending.workflowName || result.confirmationRequest || "");
  els.confirmationPanel.innerHTML = `
    <div class="ai-confirmation-title">需要确认：${escapeHtml(name)}</div>
    ${renderPendingParams(pending)}
    <div class="ai-confirmation-actions">
      <button class="ai-button ai-button-primary" data-confirm="确认" type="button">确认执行</button>
      <button class="ai-button" data-confirm="取消" type="button">取消</button>
    </div>
  `;
  els.confirmationPanel.hidden = false;
}

async function loadProjects() {
  const data = await apiFetch("/api/projects");
  state.projects = data.projects || [];
  renderProjectSelect();
  if (!state.projectName && state.projects.length > 0) {
    state.projectName = state.projects[0].name;
    renderProjectSelect();
  }
}

async function loadConfig() {
  const data = await apiFetch("/api/llm/config");
  state.config = data.config || null;
  if (!state.config) {
    els.configButton.textContent = "配置 LLM";
  } else {
    els.configButton.textContent = "LLM 配置";
  }
}

async function loadSessions() {
  const data = await apiFetch("/api/agent/sessions");
  state.sessions = data.sessions || [];
  renderSessionList();
}

async function loadLogs(sessionId) {
  if (!sessionId) {
    els.logList.innerHTML = `<div class="ai-empty">暂无执行过程</div>`;
    return;
  }
  try {
    const data = await apiFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/logs`);
    els.logList.innerHTML = (data.logs || []).map(log => `
      <div class="ai-log-item ${escapeHtml(log.type)}">
        <strong>${escapeHtml(log.type)}</strong>
        <div>${escapeHtml(log.message)}</div>
        <small>${formatTime(log.timestamp)}</small>
      </div>
    `).join("") || `<div class="ai-empty">暂无执行过程</div>`;
  } catch (error) {
    els.logList.innerHTML = `<div class="ai-empty">${escapeHtml(error.message)}</div>`;
  }
}

function renderSessionMessages(session) {
  els.chatLog.innerHTML = "";
  for (const message of session.messages || []) {
    if (message.role === "user") {
      appendMessage("user", message.content || "");
    } else if (message.role === "assistant") {
      appendMessage("agent", message.content || "");
      for (const call of message.toolCalls || []) {
        const node = document.createElement("div");
        node.className = "ai-tool-card";
        node.innerHTML = `<div class="ai-tool-head"><span class="ai-tool-name">${escapeHtml(getToolLabel(call.name))}</span></div>`;
        els.chatLog.appendChild(node);
      }
    } else if (message.role === "tool") {
      let parsed = null;
      try {
        parsed = JSON.parse(message.content || "");
      } catch (error) {
        parsed = null;
      }
      const rows = parsed ? extractRows(parsed?.data) : null;
      if (!rows || rows.length === 0) continue;
      const node = document.createElement("div");
      node.className = "ai-tool-card";
      node.innerHTML = `<div class="ai-tool-head"><span class="ai-tool-name">${escapeHtml(getToolLabel(message.name || "Tool"))}</span><span class="ai-badge">结果</span></div><div class="ai-tool-body">${renderResultTable(parsed)}</div>`;
      els.chatLog.appendChild(node);
    }
  }
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

async function selectSession(sessionId) {
  state.sessionId = sessionId;
  const data = await apiFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`);
  const session = data.session;
  state.projectName = session.projectName;
  await loadToolLabels(session.projectName);
  els.projectSelect.value = session.projectName;
  els.sessionStatus.textContent = sessionId;
  renderSessionMessages(session);
  renderConfirmation({
    confirmationRequest: session.pending?.confirm ? (session.pending.toolName || session.pending.workflowName) : undefined,
    pendingAction: session.pending,
  });
  await loadLogs(sessionId);
  renderSessionList();
}

async function newSession() {
  state.sessionId = null;
  els.sessionStatus.textContent = "新会话";
  els.chatLog.innerHTML = `<div class="ai-empty">选择项目后直接输入业务需求。</div>`;
  els.confirmationPanel.hidden = true;
  els.confirmationPanel.innerHTML = "";
  els.logList.innerHTML = `<div class="ai-empty">暂无执行过程</div>`;
  renderSessionList();
  els.messageInput.focus();
}

async function sendMessage(messageText) {
  if (state.sending) return;
  const message = String(messageText || "").trim();
  if (!message) return;
  if (!state.projectName) {
    showToast("请先选择项目");
    return;
  }
  if (!state.config) {
    openConfigModal();
    showToast("请先配置 LLM Provider");
    return;
  }
  await loadToolLabels(state.projectName);

  state.sending = true;
  els.sendButton.disabled = true;
  appendMessage("user", message);
  const thinking = appendThinking();

  try {
    const data = await apiFetch("/api/agent/chat", {
      method: "POST",
      body: JSON.stringify({
        projectName: state.projectName,
        message,
        sessionId: state.sessionId || undefined,
      }),
    });
    thinking.remove();
    const result = data.result;
    state.sessionId = result.sessionId;
    els.sessionStatus.textContent = result.sessionId;
    appendMessage("agent", result.reply || "", renderToolResults(result));
    renderConfirmation(result);
    await loadSessions();
    await loadLogs(result.sessionId);
  } catch (error) {
    thinking.remove();
    appendMessage("error", error.message || "执行失败");
  } finally {
    state.sending = false;
    els.sendButton.disabled = false;
    els.messageInput.value = "";
    els.messageInput.focus();
  }
}

function openConfigModal() {
  els.configModal.hidden = false;
  if (state.config) {
    els.configForm.elements.provider.value = state.config.provider || "";
    els.configForm.elements.baseURL.value = state.config.baseURL || "";
    els.configForm.elements.model.value = state.config.model || "";
    els.configForm.elements.apiBaseURL.value = state.config.apiBaseURL || "";
    els.configForm.elements.apiKey.value = "";
    els.configForm.elements.apiToken.value = "";
    els.configForm.elements.apiKey.placeholder = "已保存，留空则保持不变";
    els.configForm.elements.apiToken.placeholder = state.config.apiToken ? "已保存，留空则保持不变" : "可选";
  }
}

function closeConfigModal() {
  els.configModal.hidden = true;
}

async function saveConfig(event) {
  event.preventDefault();
  const form = els.configForm;
  const payload = {
    provider: form.elements.provider.value.trim(),
    baseURL: form.elements.baseURL.value.trim(),
    model: form.elements.model.value.trim(),
    apiBaseURL: form.elements.apiBaseURL.value.trim() || undefined,
  };
  if (form.elements.apiKey.value.trim()) payload.apiKey = form.elements.apiKey.value.trim();
  if (form.elements.apiToken.value.trim()) payload.apiToken = form.elements.apiToken.value.trim();
  try {
    const data = await apiFetch("/api/llm/config", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.config = data.config;
    closeConfigModal();
    showToast("LLM Provider 配置已保存");
    await loadConfig();
  } catch (error) {
    showToast(error.message);
  }
}

function bindEvents() {
  els.projectSelect.addEventListener("change", () => {
    state.projectName = els.projectSelect.value;
    newSession();
  });

  els.newSessionButton.addEventListener("click", newSession);

  els.chatForm.addEventListener("submit", event => {
    event.preventDefault();
    sendMessage(els.messageInput.value);
  });

  els.messageInput.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    els.chatForm.requestSubmit();
  });

  els.confirmationPanel.addEventListener("click", event => {
    const button = event.target.closest("[data-confirm]");
    if (!button) return;
    els.confirmationPanel.hidden = true;
    sendMessage(button.dataset.confirm);
  });

  els.sessionList.addEventListener("click", event => {
    const item = event.target.closest("[data-session]");
    if (item) selectSession(item.dataset.session);
  });

  els.refreshHistoryButton.addEventListener("click", async () => {
    await Promise.all([loadSessions(), loadLogs(state.sessionId)]);
  });

  els.configButton.addEventListener("click", openConfigModal);
  els.closeConfigButton.addEventListener("click", closeConfigModal);
  els.configModal.addEventListener("click", event => {
    if (event.target === els.configModal) closeConfigModal();
  });
  els.configForm.addEventListener("submit", saveConfig);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !els.configModal.hidden) closeConfigModal();
  });
}

async function init() {
  bindEvents();
  try {
    await Promise.all([loadProjects(), loadConfig(), loadSessions()]);
    if (state.projectName) els.projectSelect.value = state.projectName;
    newSession();
  } catch (error) {
    appendMessage("error", error.message || "初始化失败");
  }
}

document.addEventListener("DOMContentLoaded", init);
