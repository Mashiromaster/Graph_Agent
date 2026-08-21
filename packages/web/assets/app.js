const state = {
  activeNodeId: null,
  activeTaskId: null,
  provider: {
    apiKey: "",
    model: "deepseek-v4-flash",
  },
  result: null,
  running: false,
  runningTaskId: null,
  tasks: [],
  view: "chat",
};

let taskSequence = 0;

const elements = {
  agentAvatar: document.querySelector("#agentAvatar"),
  agentBudget: document.querySelector("#agentBudget"),
  agentGeneration: document.querySelector("#agentGeneration"),
  agentId: document.querySelector("#agentId"),
  agentName: document.querySelector("#agentName"),
  agentOutput: document.querySelector("#agentOutput"),
  agentPriority: document.querySelector("#agentPriority"),
  agentRole: document.querySelector("#agentRole"),
  agentTools: document.querySelector("#agentTools"),
  agentUsage: document.querySelector("#agentUsage"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  canvasSubtitle: document.querySelector("#canvasSubtitle"),
  chainBadge: document.querySelector("#chainBadge"),
  chatEmpty: document.querySelector("#chatEmpty"),
  chatScroll: document.querySelector("#chatScroll"),
  chatView: document.querySelector("#chatView"),
  checkpointList: document.querySelector("#checkpointList"),
  checkpointsView: document.querySelector("#checkpointsView"),
  edgeLayer: document.querySelector("#edgeLayer"),
  edgeMetric: document.querySelector("#edgeMetric"),
  emptyCanvas: document.querySelector("#emptyCanvas"),
  eventList: document.querySelector("#eventList"),
  eventMetric: document.querySelector("#eventMetric"),
  exportButton: document.querySelector("#exportButton"),
  graphNavButton: document.querySelector("#graphNavButton"),
  graphStage: document.querySelector("#graphStage"),
  graphView: document.querySelector("#graphView"),
  graphViewport: document.querySelector("#graphViewport"),
  healthDot: document.querySelector("#healthDot"),
  inspectorContent: document.querySelector("#inspectorContent"),
  inspectorEmpty: document.querySelector("#inspectorEmpty"),
  inspectorStatus: document.querySelector("#inspectorStatus"),
  messageList: document.querySelector("#messageList"),
  modelSelect: document.querySelector("#modelSelect"),
  nodeLayer: document.querySelector("#nodeLayer"),
  nodeMetric: document.querySelector("#nodeMetric"),
  pageTitle: document.querySelector("#pageTitle"),
  providerButton: document.querySelector("#providerButton"),
  providerDialog: document.querySelector("#providerDialog"),
  providerForm: document.querySelector("#providerForm"),
  providerLabel: document.querySelector("#providerLabel"),
  providerModelLabel: document.querySelector("#providerModelLabel"),
  providerSidebarStatus: document.querySelector("#providerSidebarStatus"),
  runButton: document.querySelector("#runButton"),
  runStateLabel: document.querySelector("#runStateLabel"),
  saveCheckpointBtn: document.querySelector("#saveCheckpointBtn"),
  sidebar: document.querySelector("#sidebar"),
  sidebarScrim: document.querySelector("#sidebarScrim"),
  statusMetric: document.querySelector("#statusMetric"),
  taskForm: document.querySelector("#taskForm"),
  taskInput: document.querySelector("#taskInput"),
  taskList: document.querySelector("#taskList"),
  toast: document.querySelector("#toast"),
  tokenMetric: document.querySelector("#tokenMetric"),
  topActions: document.querySelector("#topActions"),
};

const labels = {
  blocked: "已阻塞",
  cancelled: "已取消",
  failed: "失败",
  ready: "就绪",
  running: "运行中",
  succeeded: "已完成",
};

const eventLabels = {
  dependency_added: "依赖边已加入",
  execution_settled: "执行已结算",
  run_created: "运行已创建",
  snapshot: "快照已保存",
};

function activeTask() {
  return state.tasks.find((task) => task.id === state.activeTaskId) || null;
}

function createTask(firstMessage) {
  taskSequence += 1;
  const task = {
    createdAt: Date.now(),
    elapsed: 0,
    id: `task-${taskSequence}`,
    lastResult: null,
    messages: [],
    status: "ready",
    title: truncate(firstMessage, 34),
  };
  state.tasks.unshift(task);
  state.tasks = state.tasks.slice(0, 20);
  state.activeTaskId = task.id;
  return task;
}

function setRunning(running, taskId = state.runningTaskId) {
  state.running = running;
  state.runningTaskId = running ? taskId : null;
  elements.runButton.disabled = running;
  elements.runButton.classList.toggle("loading", running);
  syncHeader();
}

function syncHeader() {
  const task = activeTask();
  elements.pageTitle.textContent = task ? task.title : "新对话";
  if (state.running && state.runningTaskId === state.activeTaskId) {
    elements.runStateLabel.textContent = `DeepSeek ${state.provider.model} 推理中`;
  } else if (task?.status === "succeeded") {
    elements.runStateLabel.textContent = "对话已更新";
  } else if (task?.status === "failed") {
    elements.runStateLabel.textContent = "上一轮执行失败";
  } else {
    elements.runStateLabel.textContent = "准备对话";
  }
}

function conversationForRequest(messages) {
  const recent = messages.slice(-24);
  const selected = [];
  let characters = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    if (characters + message.content.length > 30_000) break;
    selected.unshift({ content: message.content, role: message.role });
    characters += message.content.length;
  }
  return selected;
}

async function runTask(taskText) {
  const normalized = taskText.trim();
  if (!normalized || state.running) return;
  if (!state.provider.apiKey) {
    openProviderDialog();
    showToast("请先配置 DeepSeek API Key", true);
    return;
  }

  const task = activeTask() || createTask(normalized);
  const conversation = conversationForRequest(task.messages);
  task.messages.push({ content: normalized, role: "user" });
  task.status = "running";
  state.result = task.lastResult;
  elements.taskInput.value = "";
  resizeTextarea();
  showChat();
  setRunning(true, task.id);
  renderTasks();
  renderChat();

  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation,
        task: normalized,
        provider: {
          type: "deepseek",
          api_key: state.provider.apiKey,
          model: state.provider.model,
        },
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "运行失败");

    const succeeded = payload.snapshot.status === "succeeded";
    const output = typeof payload.primary_output === "string" && payload.primary_output.trim()
      ? payload.primary_output.trim()
      : succeeded
        ? "本轮执行完成，但主 Agent 没有返回文本。可以打开执行图检查各节点输出。"
        : "本轮 Agent 执行失败，请检查 DeepSeek API Key、账户额度或网络后重试。";
    task.messages.push({
      content: output,
      error: !succeeded,
      result: payload,
      role: "assistant",
    });
    task.elapsed = payload.elapsed_ms;
    task.lastResult = payload;
    task.status = payload.snapshot.status;
    state.result = payload;
    state.activeNodeId = rootNodeId(payload);
    if (succeeded) {
      showToast(`回复完成 · ${payload.snapshot.nodes.length} 个节点 · ${formatDuration(payload.elapsed_ms)}`);
    } else {
      showToast("DeepSeek 调用失败，请检查 API Key、账户余额或网络", true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "运行失败";
    task.messages.push({
      content: `本轮 Agent 未能完成：${message}`,
      error: true,
      role: "assistant",
    });
    task.status = "failed";
    showToast(message, true);
  } finally {
    setRunning(false);
    renderTasks();
    if (state.activeTaskId === task.id) {
      state.result = task.lastResult;
      renderChat();
    }
  }
}

function renderChat() {
  const task = activeTask();
  elements.messageList.replaceChildren();
  const messages = task?.messages || [];
  elements.chatEmpty.hidden = messages.length > 0;

  messages.forEach((message) => {
    const article = document.createElement("article");
    article.className = `chat-message ${message.role}${message.error ? " error" : ""}`;
    if (message.role === "user") {
      const bubble = document.createElement("div");
      bubble.className = "message-bubble";
      bubble.textContent = message.content;
      article.append(bubble);
    } else {
      const heading = document.createElement("div");
      heading.className = "assistant-heading";
      const mark = document.createElement("span");
      mark.className = "assistant-mark";
      mark.textContent = "GA";
      const name = document.createElement("strong");
      name.textContent = "Graph Agent";
      heading.append(mark, name);
      const content = document.createElement("div");
      content.className = "assistant-content";
      content.textContent = message.content;
      article.append(heading, content);
      if (message.result) article.append(renderMessageMeta(message.result));
    }
    elements.messageList.append(article);
  });

  if (task && task.status === "running" && state.runningTaskId === task.id) {
    const loading = document.createElement("article");
    loading.className = "chat-message assistant loading-message";
    const heading = document.createElement("div");
    heading.className = "assistant-heading";
    const mark = document.createElement("span");
    mark.className = "assistant-mark";
    mark.textContent = "GA";
    const copy = document.createElement("span");
    copy.textContent = "正在组织 Agent 图并生成回答";
    const dots = document.createElement("i");
    dots.className = "thinking-dots";
    dots.textContent = "•••";
    heading.append(mark, copy, dots);
    loading.append(heading);
    elements.messageList.append(loading);
  }

  window.requestAnimationFrame(() => {
    elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
  });
}

function renderMessageMeta(result) {
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const summary = document.createElement("span");
  const tokens = result.snapshot.budget.committed_tokens;
  summary.textContent = `${result.provider.model} · ${result.snapshot.nodes.length} 节点 · ${formatNumber(tokens)} tokens · ${formatDuration(result.elapsed_ms)}`;
  const graphButton = document.createElement("button");
  graphButton.type = "button";
  graphButton.textContent = "查看执行图";
  graphButton.addEventListener("click", () => showGraph(result));
  meta.append(summary, graphButton);
  return meta;
}

function renderTasks() {
  elements.taskList.replaceChildren();
  if (!state.tasks.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "新对话会显示在这里";
    elements.taskList.append(empty);
    return;
  }

  state.tasks.forEach((task) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `history-item${task.id === state.activeTaskId ? " active" : ""}`;
    const dot = document.createElement("i");
    dot.className = task.status;
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const turns = task.messages.filter((message) => message.role === "user").length;
    title.textContent = task.title;
    meta.textContent = task.status === "running"
      ? `${turns} 轮 · 运行中`
      : `${turns} 轮${task.elapsed ? ` · ${formatDuration(task.elapsed)}` : ""}`;
    copy.append(title, meta);
    item.append(dot, copy);
    item.addEventListener("click", () => selectTask(task.id));
    elements.taskList.append(item);
  });
}

function selectTask(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  state.activeTaskId = taskId;
  state.result = task.lastResult;
  state.activeNodeId = rootNodeId(task.lastResult);
  showChat();
  renderTasks();
  renderChat();
  syncHeader();
  setSidebar(false);
  elements.taskInput.focus();
}

function newConversation() {
  state.activeNodeId = null;
  state.activeTaskId = null;
  state.result = null;
  showChat();
  renderTasks();
  renderChat();
  syncHeader();
  setSidebar(false);
  elements.taskInput.focus();
}

function showChat() {
  state.view = "chat";
  elements.chatView.hidden = false;
  elements.graphView.hidden = true;
  elements.checkpointsView.hidden = true;
  elements.topActions.hidden = true;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  syncHeader();
}

function showGraph(result = state.result) {
  state.view = "graph";
  state.result = result || null;
  state.activeNodeId = rootNodeId(state.result);
  elements.chatView.hidden = true;
  elements.graphView.hidden = false;
  elements.checkpointsView.hidden = true;
  elements.topActions.hidden = false;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  elements.graphNavButton.classList.add("active");
  setSidebar(false);
  if (state.result) renderGraphResult();
  else resetGraphUI();
  syncHeader();
}

function showCheckpoints() {
  state.view = "checkpoints";
  elements.chatView.hidden = true;
  elements.graphView.hidden = true;
  elements.checkpointsView.hidden = false;
  elements.topActions.hidden = true;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  document.querySelector('.nav-item[data-view="checkpoints"]')?.classList.add("active");
  setSidebar(false);
  renderCheckpoints();
  syncHeader();
}

async function renderCheckpoints() {
  elements.saveCheckpointBtn.disabled = !state.result?.checkpoint;
  elements.checkpointList.replaceChildren();
  let checkpoints;
  try {
    const response = await fetch("/api/checkpoints");
    if (!response.ok) throw new Error("列表加载失败");
    ({ checkpoints } = await response.json());
  } catch (error) {
    showToast(error instanceof Error ? error.message : "无法加载 checkpoint 列表", true);
    return;
  }
  if (state.view !== "checkpoints") return;
  if (!checkpoints || checkpoints.length === 0) {
    const empty = document.createElement("div");
    empty.className = "checkpoint-empty";
    empty.textContent = "还没有保存的 checkpoint。完成一轮对话后,回到这里保存当前运行。";
    elements.checkpointList.append(empty);
    return;
  }

  checkpoints.forEach((meta) => {
    const item = document.createElement("div");
    item.className = "checkpoint-item";
    const copy = document.createElement("div");
    copy.className = "checkpoint-copy";
    const title = document.createElement("strong");
    title.textContent = String(meta.runId || meta.id).slice(0, 22);
    const info = document.createElement("span");
    info.className = "checkpoint-meta";
    info.textContent = `${labels[meta.status] || meta.status} · ${meta.nodeCount} 节点 · ${meta.eventCount} 事件`;
    copy.append(title, info);

    const actions = document.createElement("div");
    actions.className = "checkpoint-actions";
    const viewButton = document.createElement("button");
    viewButton.type = "button";
    viewButton.className = "secondary-button";
    viewButton.textContent = "查看";
    viewButton.addEventListener("click", () => viewCheckpoint(meta.id));
    const resumeButton = document.createElement("button");
    resumeButton.type = "button";
    resumeButton.className = "secondary-button";
    resumeButton.textContent = "续跑";
    resumeButton.addEventListener("click", () => resumeCheckpoint(meta.id));
    actions.append(viewButton, resumeButton);

    item.append(copy, actions);
    elements.checkpointList.append(item);
  });
}

async function saveCurrentCheckpoint() {
  if (!state.result?.checkpoint) {
    showToast("当前没有可保存的运行", true);
    return;
  }
  try {
    const response = await fetch("/api/checkpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkpoint: state.result.checkpoint }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "保存失败");
    showToast("已保存");
    renderCheckpoints();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "保存失败", true);
  }
}

/**
 * Project a stored v2 checkpoint JSON into a minimal StudioResult so the graph
 * view can render the saved topology read-only. The final snapshot lives in the
 * last `snapshot`-type event's detail; archived results (if any) back the
 * inspector node outputs.
 */
function checkpointToResult(checkpointJson) {
  const checkpoint = JSON.parse(checkpointJson);
  const events = Array.isArray(checkpoint.events) ? checkpoint.events : [];
  let snapshot = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "snapshot") {
      const detail = JSON.parse(events[index].detailJson);
      snapshot = detail.snapshot;
      break;
    }
  }
  const archived = checkpoint.resumable?.archivedResults ?? [];
  const nodeResults = archived.map((entry) => {
    const result = entry.result || {};
    return {
      node_id: result.nodeId,
      status: result.status,
      output: result.output ?? null,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
      },
      error: result.error ? { code: result.error.code, message: result.error.message } : null,
    };
  });
  const rootArchived = nodeResults.find((entry) => entry.node_id === "root");
  return {
    controller_event_chain_valid: true,
    elapsed_ms: 0,
    event_count: checkpoint.eventCount ?? events.length,
    events: events.map((event) => ({
      hash: String(event.eventHash || "").slice(0, 12),
      sequence: event.sequence,
      type: event.type,
    })),
    live: false,
    node_results: nodeResults,
    primary_output: rootArchived ? rootArchived.output : null,
    provider: state.result?.provider ?? {
      endpoint: "https://api.deepseek.com",
      model: state.provider.model,
      thinking: "disabled",
      type: "deepseek",
    },
    snapshot,
    task: "(已保存的 checkpoint)",
    checkpoint: checkpointJson,
  };
}

async function viewCheckpoint(id) {
  try {
    const response = await fetch(`/api/checkpoints/${id}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "加载失败");
    const result = checkpointToResult(payload.checkpoint);
    if (!result.snapshot) throw new Error("checkpoint 缺少快照");
    showGraph(result);
    showToast("已载入 checkpoint(只读)");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "加载失败", true);
  }
}

async function resumeCheckpoint(id) {
  if (!state.provider.apiKey) {
    openProviderDialog();
    showToast("续跑需要先配置 DeepSeek API Key", true);
    return;
  }
  const task = createTask("续跑 checkpoint");
  task.status = "running";
  setRunning(true, task.id);
  renderTasks();
  try {
    const response = await fetch("/api/checkpoints/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        provider: {
          type: "deepseek",
          api_key: state.provider.apiKey,
          model: state.provider.model,
        },
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "续跑失败");
    task.elapsed = payload.elapsed_ms;
    task.lastResult = payload;
    task.status = payload.snapshot.status;
    showGraph(payload);
    showToast("续跑完成");
  } catch (error) {
    task.status = "failed";
    showToast(error instanceof Error ? error.message : "续跑失败", true);
  } finally {
    setRunning(false);
    renderTasks();
  }
}

function renderGraphResult() {
  if (!state.result) return;
  const { snapshot } = state.result;
  elements.nodeMetric.textContent = String(snapshot.nodes.length);
  elements.edgeMetric.textContent = String(snapshot.edges.length);
  elements.tokenMetric.textContent = formatNumber(snapshot.budget.committed_tokens);
  elements.eventMetric.textContent = String(state.result.event_count);
  elements.statusMetric.textContent = labels[snapshot.status] || snapshot.status;
  elements.statusMetric.className = snapshot.status;
  elements.canvasSubtitle.textContent = truncate(state.result.task, 72);
  elements.emptyCanvas.hidden = true;
  elements.graphStage.hidden = false;
  elements.exportButton.disabled = false;
  window.requestAnimationFrame(() => {
    renderGraph();
    renderInspector();
    renderEvents();
  });
}

function renderGraph() {
  if (!state.result) return;
  const nodes = state.result.snapshot.nodes;
  const edges = state.result.snapshot.edges;
  const width = Math.max(elements.graphViewport.clientWidth, 520);
  const height = Math.max(elements.graphViewport.clientHeight, 420);
  const generations = [...new Set(nodes.map((node) => node.generation))].sort((a, b) => a - b);
  const maxGeneration = Math.max(...generations, 1);
  const positions = new Map();

  for (const generation of generations) {
    const group = nodes.filter((node) => node.generation === generation);
    const x = 118 + generation * ((width - 236) / maxGeneration);
    group.forEach((node, index) => {
      const y = ((index + 1) * height) / (group.length + 1);
      positions.set(node.node_id, { x, y });
    });
  }

  elements.graphStage.style.width = `${width}px`;
  elements.graphStage.style.height = `${height}px`;
  elements.edgeLayer.setAttribute("viewBox", `0 0 ${width} ${height}`);
  elements.edgeLayer.replaceChildren();
  elements.nodeLayer.replaceChildren();

  edges.forEach((edge) => {
    const source = positions.get(edge.source_node_id);
    const target = positions.get(edge.target_node_id);
    if (!source || !target) return;
    const edgeClass = edge.type === "depends_on" ? "dependency" : "spawn";
    const startX = source.x + 99;
    const endX = target.x - 99;
    const bend = Math.max((endX - startX) * 0.48, 36);
    elements.edgeLayer.append(svgElement("path", {
      class: edgeClass,
      d: `M ${startX} ${source.y} C ${startX + bend} ${source.y}, ${endX - bend} ${target.y}, ${endX} ${target.y}`,
    }));
    elements.edgeLayer.append(svgElement("circle", { class: edgeClass, cx: endX, cy: target.y, r: 3.2 }));
    const label = svgElement("text", {
      x: (startX + endX) / 2,
      y: (source.y + target.y) / 2 - 8,
      "text-anchor": "middle",
    });
    label.textContent = edge.type === "depends_on" ? "depends" : `w ${Number(edge.weight).toFixed(2)}`;
    elements.edgeLayer.append(label);
  });

  nodes.forEach((node) => {
    const position = positions.get(node.node_id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `graph-node${node.node_id === state.activeNodeId ? " selected" : ""}`;
    button.dataset.nodeId = node.node_id;
    button.dataset.role = node.role;
    button.style.left = `${position.x}px`;
    button.style.top = `${position.y}px`;
    const avatar = document.createElement("span");
    avatar.className = "node-avatar";
    avatar.textContent = initials(node.role);
    const copy = document.createElement("span");
    copy.className = "node-copy";
    const name = document.createElement("strong");
    name.textContent = node.name;
    const role = document.createElement("span");
    role.textContent = `G${node.generation} · ${displayRole(node.role)}`;
    copy.append(name, role);
    const status = document.createElement("i");
    status.className = `node-state ${node.state}`;
    status.title = labels[node.state] || node.state;
    button.append(avatar, copy, status);
    button.addEventListener("click", () => {
      state.activeNodeId = node.node_id;
      renderGraph();
      renderInspector();
    });
    elements.nodeLayer.append(button);
  });
}

function renderInspector() {
  if (!state.result) return;
  const node = state.result.snapshot.nodes.find((item) => item.node_id === state.activeNodeId);
  if (!node) {
    elements.inspectorEmpty.hidden = false;
    elements.inspectorContent.hidden = true;
    return;
  }
  elements.inspectorEmpty.hidden = true;
  elements.inspectorContent.hidden = false;
  elements.inspectorStatus.textContent = labels[node.state] || node.state;
  elements.inspectorStatus.className = `inspector-status ${node.state}`;
  elements.agentAvatar.textContent = initials(node.role);
  elements.agentAvatar.style.background = node.role === "planner" ? "var(--blue)" : node.role === "reviewer" ? "var(--violet)" : "#292a27";
  elements.agentName.textContent = node.name;
  elements.agentRole.textContent = displayRole(node.role);
  elements.agentId.textContent = node.node_id;
  elements.agentGeneration.textContent = String(node.generation);
  elements.agentPriority.textContent = Number(node.priority).toFixed(2);
  elements.agentBudget.textContent = formatNumber(node.allocation_tokens);
  elements.agentTools.textContent = node.allowed_tool_names.length ? node.allowed_tool_names.join(", ") : "none";
  const nodeResult = state.result.node_results?.find((item) => item.node_id === node.node_id);
  if (nodeResult) {
    const totalTokens = nodeResult.usage.input_tokens + nodeResult.usage.output_tokens;
    elements.agentUsage.textContent = `${formatNumber(totalTokens)} tokens`;
    elements.agentOutput.textContent = nodeResult.output
      || (nodeResult.error ? "模型执行失败，请检查 DeepSeek 配置后重试。" : "节点未返回文本输出。已按状态记录完成。");
  } else {
    elements.agentUsage.textContent = "—";
    elements.agentOutput.textContent = "尚未采集到该节点的运行结果。";
  }
}

function renderEvents() {
  if (!state.result) return;
  elements.chainBadge.textContent = state.result.controller_event_chain_valid ? "哈希链有效" : "验证失败";
  elements.chainBadge.className = state.result.controller_event_chain_valid ? "valid" : "";
  elements.eventList.replaceChildren();
  state.result.events.slice(-8).forEach((event) => {
    const item = document.createElement("li");
    item.textContent = `${eventLabels[event.type] || event.type} · ${event.hash}`;
    elements.eventList.append(item);
  });
}

function resetGraphUI() {
  state.activeNodeId = null;
  elements.nodeMetric.textContent = "—";
  elements.edgeMetric.textContent = "—";
  elements.tokenMetric.textContent = "—";
  elements.eventMetric.textContent = "—";
  elements.statusMetric.textContent = "未运行";
  elements.statusMetric.className = "";
  elements.canvasSubtitle.textContent = "完成一轮对话后，可在这里查看 Agent 执行过程";
  elements.emptyCanvas.hidden = false;
  elements.graphStage.hidden = true;
  elements.exportButton.disabled = true;
  elements.inspectorEmpty.hidden = false;
  elements.inspectorContent.hidden = true;
  elements.inspectorStatus.textContent = "—";
  elements.inspectorStatus.className = "inspector-status";
  elements.chainBadge.textContent = "未验证";
  elements.chainBadge.className = "";
  elements.eventList.replaceChildren();
  const event = document.createElement("li");
  event.textContent = "等待运行事件";
  elements.eventList.append(event);
}

function resetGraphSelection() {
  if (!state.result) return;
  state.activeNodeId = rootNodeId(state.result);
  renderGraph();
  renderInspector();
}

function rootNodeId(result) {
  if (!result?.snapshot?.nodes?.length) return null;
  return result.snapshot.nodes.find((node) => node.generation === 0)?.node_id
    || result.snapshot.nodes[0].node_id;
}

function exportSnapshot() {
  if (!state.result) return;
  const blob = new Blob([JSON.stringify(state.result, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.result.snapshot.run_id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("快照已导出为 JSON");
}

function showToast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.className = `toast visible${error ? " error" : ""}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.toast.className = "toast";
  }, 2600);
}

function openProviderDialog() {
  elements.modelSelect.value = state.provider.model;
  elements.apiKeyInput.value = "";
  elements.apiKeyInput.type = "password";
  elements.apiKeyInput.placeholder = state.provider.apiKey ? "已配置；留空可保留当前密钥" : "sk-…";
  document.querySelector("#toggleApiKey").textContent = "显示";
  if (!elements.providerDialog.open) elements.providerDialog.showModal();
  window.requestAnimationFrame(() => elements.apiKeyInput.focus());
}

function updateProviderUI() {
  const connected = Boolean(state.provider.apiKey);
  elements.providerButton.classList.toggle("connected", connected);
  elements.providerLabel.textContent = connected ? "DeepSeek 已连接" : "配置 DeepSeek API";
  elements.providerModelLabel.textContent = state.provider.model;
  elements.providerSidebarStatus.textContent = connected ? "DeepSeek 已连接" : "DeepSeek 未连接";
  elements.providerButton.setAttribute("aria-label", connected ? "修改 DeepSeek 连接" : "配置 DeepSeek API");
}

function saveProvider(event) {
  event.preventDefault();
  const enteredKey = elements.apiKeyInput.value;
  if (enteredKey && (enteredKey !== enteredKey.trim() || enteredKey.length < 8)) {
    showToast("API Key 格式无效，请检查首尾空格", true);
    elements.apiKeyInput.focus();
    return;
  }
  if (!enteredKey && !state.provider.apiKey) {
    showToast("请输入 DeepSeek API Key", true);
    elements.apiKeyInput.focus();
    return;
  }
  if (enteredKey) state.provider.apiKey = enteredKey;
  state.provider.model = elements.modelSelect.value;
  updateProviderUI();
  elements.providerDialog.close();
  showToast(`已连接 ${state.provider.model} · 密钥未落盘`);
  elements.taskInput.focus();
}

function clearProvider() {
  state.provider.apiKey = "";
  elements.apiKeyInput.value = "";
  updateProviderUI();
  elements.providerDialog.close();
  showToast("DeepSeek API Key 已从页面内存清除");
}

function setSidebar(open) {
  elements.sidebar.classList.toggle("open", open);
  elements.sidebarScrim.classList.toggle("open", open);
  document.querySelector("#menuButton").setAttribute("aria-expanded", String(open));
  syncSidebarAccessibility(open);
}

function syncSidebarAccessibility(open = elements.sidebar.classList.contains("open")) {
  const mobile = window.matchMedia("(max-width: 820px)").matches;
  elements.sidebar.toggleAttribute("inert", mobile && !open);
  if (mobile && !open) elements.sidebar.setAttribute("aria-hidden", "true");
  else elements.sidebar.removeAttribute("aria-hidden");
}

function resizeTextarea() {
  elements.taskInput.style.height = "auto";
  elements.taskInput.style.height = `${Math.min(elements.taskInput.scrollHeight, 130)}px`;
}

function svgElement(name, attributes) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
}

function initials(role) {
  return role.split(/[\s_-]+/).map((part) => part[0] || "").join("").slice(0, 2).toUpperCase();
}

function displayRole(role) {
  return role ? `${role.charAt(0).toUpperCase()}${role.slice(1)}` : "Agent";
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatDuration(milliseconds) {
  return milliseconds >= 1_000
    ? `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 1 : 2)} s`
    : `${milliseconds} ms`;
}

elements.taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runTask(elements.taskInput.value);
});
elements.taskInput.addEventListener("input", resizeTextarea);
elements.taskInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.taskForm.requestSubmit();
  }
});
document.querySelector("#newRunButton").addEventListener("click", newConversation);
document.querySelector("#resetButton").addEventListener("click", resetGraphSelection);
elements.exportButton.addEventListener("click", exportSnapshot);
elements.providerButton.addEventListener("click", openProviderDialog);
elements.providerForm.addEventListener("submit", saveProvider);
document.querySelector("#providerDialogClose").addEventListener("click", () => elements.providerDialog.close());
document.querySelector("#clearApiKey").addEventListener("click", clearProvider);
document.querySelector("#toggleApiKey").addEventListener("click", (event) => {
  const showing = elements.apiKeyInput.type === "text";
  elements.apiKeyInput.type = showing ? "password" : "text";
  event.currentTarget.textContent = showing ? "显示" : "隐藏";
});
elements.providerDialog.addEventListener("close", () => {
  elements.apiKeyInput.value = "";
  elements.apiKeyInput.type = "password";
});
elements.providerDialog.addEventListener("click", (event) => {
  if (event.target === elements.providerDialog) elements.providerDialog.close();
});
document.querySelector("#menuButton").addEventListener("click", () => setSidebar(true));
document.querySelector("#sidebarClose").addEventListener("click", () => setSidebar(false));
elements.sidebarScrim.addEventListener("click", () => setSidebar(false));
elements.graphNavButton.addEventListener("click", () => showGraph(activeTask()?.lastResult || state.result));
elements.saveCheckpointBtn.addEventListener("click", saveCurrentCheckpoint);
document.querySelector('.nav-item[data-view="checkpoints"]').addEventListener("click", () => {
  showCheckpoints();
});
document.querySelector('.nav-item[data-view="policies"]').addEventListener("click", () => {
  showToast("策略与预算沿用 Controller 安全策略");
  setSidebar(false);
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    newConversation();
  }
});

new ResizeObserver(() => {
  if (state.result && state.view === "graph") renderGraph();
}).observe(elements.graphViewport);

fetch("/api/health")
  .then((response) => {
    if (!response.ok) throw new Error("offline");
    elements.healthDot.classList.add("online");
  })
  .catch(() => showToast("本地服务不可用", true));

resizeTextarea();
updateProviderUI();
renderTasks();
renderChat();
syncHeader();
syncSidebarAccessibility(false);
window.matchMedia("(max-width: 820px)").addEventListener("change", () => syncSidebarAccessibility(false));
