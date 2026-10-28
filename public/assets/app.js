/**
 * EdgeMirror — frontend controller.
 *
 * No framework, no build step: the whole app is one module the browser can
 * run directly. State is derived from /api/nodes at boot; node health is a
 * separate concern that never blocks the UI.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  service: "github",
  services: [],
  nodes: [],
  health: new Map(),
  selectedNode: null,
  lastResult: null,
};

/* ------------------------------------------------------------------ utils */

function toast(message, kind = "ok") {
  const el = $("#toast");
  const txt = $("#toast-text");
  if (!el) return;
  el.dataset.kind = kind;
  el.dataset.show = "true";
  txt.textContent = message;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.dataset.show = "false";
  }, 2200);
}

async function copyText(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
    } else {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast("已复制到剪贴板");
  } catch {
    toast("复制失败，请手动选择文本", "error");
  }
}

const svgIcon = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const SERVICE_ICONS = {
  github: {
    fill: true,
    svg: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.9 18.3 5.2 18.3 5.2c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5Z"/></svg>`,
  },
  docker: {
    fill: true,
    svg: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.98 11.08h2.12v2.3h-2.12zM11.2 11.08h2.12v2.3H11.2zM8.42 11.08h2.12v2.3H8.42zM5.64 11.08h2.12v2.3H5.64zM8.42 8.35h2.12v2.3H8.42zM11.2 8.35h2.12v2.3H11.2zM8.42 5.62h2.12v2.3H8.42zM23.76 11.7c-.13-.1-.76-.57-2.19-.57-.4 0-.79.03-1.16.09-.28-1.94-1.89-2.88-1.96-2.92l-.4-.23-.26.39c-.32.51-.55 1.1-.66 1.71-.25 1.02-.1 1.98.42 2.8-.62.35-1.62.43-1.82.44H.94c-.26 0-.47.21-.48.47-.03 1.11.17 2.21.6 3.23.5 1.13 1.24 1.97 2.21 2.5 1.09.6 2.86.94 4.86.94 1.04 0 2.07-.09 3.07-.28 1.42-.26 2.78-.75 4.02-1.46 1.03-.59 1.95-1.34 2.73-2.21 1.3-1.46 2.07-3.09 2.64-4.2h.23c1.39 0 2.24-.56 2.71-1.02.31-.3.56-.67.71-1.08l.1-.3-.33-.25Z"/></svg>`,
  },
  sourceforge: {
    fill: false,
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>`,
  },
};

/* -------------------------------------------------------------- URL logic */

/** Build the accelerated URL for the current service. */
function buildProxyUrl(service, raw, nodeId) {
  const origin = window.location.origin;
  const value = raw.trim();
  const node =
    state.nodes.find((n) => n.id === nodeId) ||
    state.nodes.find((n) => n.id === state.selectedNode) ||
    state.nodes.find((n) => n.kind === "primary") ||
    state.nodes[0];

  if (service === "docker") {
    const img = value
      .replace(/^https?:\/\/[^/]+\//, "")
      .replace(/^docker\.io\//, "")
      .replace(/^index\.docker\.io\//, "");
    return {
      url: `${origin}/${img}`,
      kind: "Docker Image",
      cache: "immutable · 1y",
      command: `docker pull ${location.host}/${img}`,
      node: node?.id || "docker-hub",
    };
  }

  if (service === "github") {
    let target = value;
    if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
    let u;
    try {
      u = new URL(target);
    } catch {
      return null;
    }
    const url = `${origin}/gh/${u.host}${u.pathname}${u.search}`;
    return {
      url,
      kind: "GitHub Asset",
      cache: /\/releases\/download\//.test(u.pathname)
        ? "immutable · 1y"
        : "1h",
      command: `curl -L -O ${url}`,
      node: node?.id || "ghproxy",
      // 302 到镜像站，字节不经过本站
      mode: node?.mode || "redirect",
    };
  }

  if (service === "sourceforge") {
    let target = value;
    if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
    let u;
    try {
      u = new URL(target);
    } catch {
      return null;
    }
    const url = `${origin}/sf/${u.host}${u.pathname}${u.search}`;
    return {
      url,
      kind: "SourceForge File",
      cache: "24h",
      command: `wget -c ${url}`,
      node: node?.id || "direct",
      // 透传 SourceForge 自己的镜像重定向
      mode: "redirect",
    };
  }
  return null;
}

/* ------------------------------------------------------------------- view */

function renderTabs() {
  $$(".tab").forEach((tab) => {
    const on = tab.dataset.service === state.service;
    tab.setAttribute("aria-selected", on ? "true" : "false");
    // Roving tabindex: only the selected tab is in the tab order, arrow
    // keys move between them (WAI-ARIA tabs pattern).
    tab.setAttribute("tabindex", on ? "0" : "-1");
    tab.addEventListener("click", () =>
      selectService(tab.dataset.service, { focusInput: true })
    );
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const tabs = $$(".tab");
      const i = tabs.indexOf(tab);
      const next =
        e.key === "ArrowRight"
          ? tabs[(i + 1) % tabs.length]
          : tabs[(i - 1 + tabs.length) % tabs.length];
      next.focus();
      selectService(next.dataset.service);
    });
  });
}

function selectService(id, { focusInput = false } = {}) {
  const svc = state.services.find((s) => s.id === id);
  if (!svc) return;
  state.service = id;

  $$(".tab").forEach((t) => {
    const on = t.dataset.service === id;
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.setAttribute("tabindex", on ? "0" : "-1");
  });
  $("#panel").setAttribute("aria-labelledby", `tab-${id}`);

  const input = $("#url-input");
  input.placeholder = svc.placeholder;
  input.value = "";
  $("#url-label").textContent = svc.name;

  // Examples for this service.
  const box = $("#examples");
  box.innerHTML = "<span>快捷示例：</span>";
  (svc.examples || []).forEach((ex) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "example-btn";
    b.textContent = ex.label;
    b.addEventListener("click", () => {
      input.value = ex.command || ex.url;
      runConvert();
    });
    box.appendChild(b);
  });

  // Docker has no node chips — the registry path is fixed.
  const row = $(".nodes-row");
  if (row) row.style.display = id === "docker" ? "none" : "";

  // Node availability differs per service (a mirror may only carry GitHub),
  // so the chip list must be recomputed whenever the service changes.
  renderNodeChips();

  hideOutput();

  // Only steal focus on an explicit click. On boot and on keyboard arrow
  // navigation the tab itself keeps focus, which is what ARIA tabs expect.
  if (focusInput) input.focus({ preventScroll: true });
}

function renderNodeChips() {
  const box = $("#node-chips");
  if (!box) return;
  box.innerHTML = "";

  const usable = state.nodes.filter(
    (n) =>
      !state.service ||
      !n.services ||
      n.services.includes(state.service) ||
      n.kind === "primary"
  );

  usable.forEach((node) => {
    const health = state.health.get(node.id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.dataset.node = node.id;
    btn.setAttribute(
      "aria-pressed",
      state.selectedNode === node.id ? "true" : "false"
    );
    const lat = health?.latencyMs != null ? `${health.latencyMs}ms` : "";
    btn.innerHTML = `<span class="dot" style="width:5px;height:5px;${
      health?.status === "up" ? "" : "background: var(--text-muted); box-shadow:none;"
    }"></span>${node.name}${
      lat ? `<span class="lat">${lat}</span>` : ""
    }`;
    btn.addEventListener("click", () => {
      state.selectedNode = node.id;
      renderNodeChips();
      if (state.lastResult) runConvert();
      toast(`已切换到 ${node.name}`);
    });
    box.appendChild(btn);
  });
}

function renderNodesTable() {
  const table = $("#node-table");
  if (!table) return;
  table.innerHTML = "";

  state.nodes.forEach((node) => {
    const health = state.health.get(node.id);
    const row = document.createElement("div");
    row.className = "node-row";

    const statusMap = {
      up: ["badge-up", "在线"],
      degraded: ["badge-wait", "降级"],
      down: ["badge-down", "离线"],
    };
    const [cls, label] = health
      ? statusMap[health.status] || ["badge-wait", "未知"]
      : ["badge-wait", "检测中"];

    row.innerHTML = `
      <div class="node-id">
        <span class="node-flag">${node.flag || "—"}</span>
        <span class="node-name">${node.name}</span>
      </div>
      <span class="node-region">${node.region}</span>
      <span class="node-lat">${
        health?.latencyMs != null ? health.latencyMs + " ms" : "—"
      }</span>
      <span class="badge ${cls}">${label}</span>
    `;
    table.appendChild(row);
  });
}

function updateNavStatus() {
  const el = $("#nav-status");
  const txt = $("#nav-status-text");
  if (!el || !txt) return;
  const total = state.nodes.length;
  const up = [...state.health.values()].filter((h) => h.status === "up").length;
  if (!total) {
    el.dataset.state = "checking";
    txt.textContent = "检测中";
    return;
  }
  if (up === 0) {
    el.dataset.state = "down";
    txt.textContent = "节点异常";
  } else {
    el.dataset.state = "up";
    txt.textContent = `${up}/${total} 节点在线`;
  }
}

function showOutput(result) {
  const box = $("#output");
  const link = $("#output-url");
  const open = $("#open-output");
  if (!box || !link) return;
  box.hidden = false;
  link.textContent = result.url;
  link.href = result.url;
  if (open) open.href = result.url;
  $("#meta-node").textContent = result.node;
  $("#meta-kind").textContent = result.kind;
  $("#meta-cache").textContent =
    result.mode === "redirect"
      ? `${result.cache} · 302 直达`
      : result.cache;
}

function hideOutput() {
  const box = $("#output");
  if (box) box.hidden = true;
  state.lastResult = null;
}

/* ------------------------------------------------------------------ flow */

function runConvert() {
  const input = $("#url-input");
  const value = input.value.trim();
  if (!value) {
    input.focus();
    toast("请先粘贴一个链接", "error");
    return;
  }

  // Reject junk before building a URL that would only fail server-side.
  if (state.service !== "docker" && !looksLikeUrl(value)) {
    hideOutput();
    toast("链接格式无法识别，请检查后重试", "error");
    return;
  }

  const result = buildProxyUrl(state.service, value, state.selectedNode);
  if (!result) {
    hideOutput();
    toast("链接格式无法识别，请检查后重试", "error");
    return;
  }
  state.lastResult = result;
  showOutput(result);
}

/**
 * A pasted value is usable when it parses as http(s) and has a host with a
 * dot. Bare words ("not a url") and scheme-less garbage are rejected here
 * rather than producing a URL that 400s on the server.
 */
function looksLikeUrl(value) {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname;
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) {
    return false;
  }
  // "not a url at all" parses as host "not" once " a url at all" hits the
  // path; require a plausible TLD-shaped suffix.
  const tld = host.split(".").pop();
  return /^[a-z]{2,}$/i.test(tld);
}

async function loadConfig() {
  try {
    const res = await fetch("/api/nodes", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    state.services = data.services || [];
    state.nodes = data.nodes || [];
    state.selectedNode =
      state.nodes.find((n) => n.kind === "primary")?.id || state.nodes[0]?.id;
    renderTabs();
    renderNodeChips();
    renderNodesTable();
    selectService(state.services[0]?.id || "github");

    // Preferred input: example is a command (docker) vs a URL.
    const first = state.services[0];
    if (first?.examples?.length) {
      $("#url-input").placeholder = first.placeholder;
    }
  } catch (err) {
    toast("节点配置加载失败，请刷新页面", "error");
    console.error(err);
  }
}

async function loadHealth() {
  const btn = $("#refresh-nodes");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/health", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    state.health.clear();
    (data.nodes || []).forEach((n) => state.health.set(n.id, n));
    renderNodesTable();
    renderNodeChips();
    updateNavStatus();
  } catch {
    updateNavStatus();
  } finally {
    if (btn) btn.disabled = false;
    const t = $("#node-table");
    if (t) t.setAttribute("aria-busy", "false");
  }
}

/* ------------------------------------------------------------------- boot */

function init() {
  const year = $("#year");
  if (year) year.textContent = String(new Date().getFullYear());

  $("#proxy-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    runConvert();
  });

  $("#copy-output")?.addEventListener("click", () => {
    if (state.lastResult) copyText(state.lastResult.url);
  });

  $("#refresh-nodes")?.addEventListener("click", loadHealth);

  $$(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => copyText(btn.dataset.copy || ""));
  });

  // Keyboard shortcut: "/" focuses the input, like a search box.
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
      e.preventDefault();
      $("#url-input")?.focus();
    }
  });

  loadConfig().then(() => {
    loadHealth();
    setInterval(loadHealth, 60000);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
