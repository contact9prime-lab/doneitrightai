/* TrainForge UI application.
 *
 * Plain ES2020, no dependencies. Structure:
 *
 *   api / helpers   — fetch wrapper, formatting, toasts, modal
 *   router          — hash routes (#/autopilot, #/datasets/…) render views
 *   views           — one render function per screen
 *   loss chart      — hand-rolled canvas line chart (see drawLossChart)
 *
 * Live updates use plain polling (2–3s) — no websockets to configure, works
 * through any reverse proxy. Each view registers its poller with setPoll();
 * navigation clears it automatically.
 */

"use strict";

const view = document.getElementById("view");

/* ================= api & helpers ================= */

async function api(path, opts = {}) {
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers = { "Content-Type": "application/json", ...opts.headers };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    throw new Error((data && (data.detail || data.error)) || `HTTP ${res.status}`);
  }
  return data;
}

/** Escape untrusted text for interpolation into HTML templates. */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtBytes(n) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtWhen(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(a, b) {
  if (!a) return "—";
  const s = Math.max(0, Math.round((b || Date.now() / 1000) - a));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function badge(status) {
  return `<span class="badge ${esc(status)}">${esc(status)}</span>`;
}

let toastTimer = null;
function toast(message, bad = false) {
  const t = document.getElementById("toast");
  t.textContent = message;
  t.className = bad ? "bad" : "";
  t.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = "none"; }, bad ? 6000 : 3500);
}

/** Render a modal; returns a close() function. Closes on backdrop click. */
function modal(html) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal">${html}</div>`;
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
  function close() { backdrop.remove(); }
  return { root: backdrop, close };
}

/* -- polling: one active poller per view, cleared on navigation -- */
let pollHandle = null;
function setPoll(fn, ms) {
  clearPoll();
  pollHandle = setInterval(() => fn().catch(() => {}), ms);
}
function clearPoll() {
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
}

/* ================= system chips (header) ================= */

async function refreshSysChips() {
  try {
    const info = await api("/api/system/info");
    const chips = [];
    if (info.gpus && info.gpus.length) {
      const g = info.gpus[0];
      chips.push(`<span class="chip ok" title="reported by nvidia-smi"><span class="dot"></span>
        ${esc(g.name)} · ${Math.round(g.memory_used_mb / 1024 * 10) / 10}/${Math.round(g.memory_total_mb / 1024)} GB · ${g.utilization_pct}%</span>`);
    } else if (info.torch && info.torch.cuda_available) {
      chips.push(`<span class="chip ok"><span class="dot"></span>${esc(info.torch.device_name || "CUDA GPU")}</span>`);
    } else {
      chips.push(`<span class="chip warn" title="No CUDA GPU detected — tabular tasks still work on CPU"><span class="dot"></span>CPU only</span>`);
    }
    chips.push(info.hf_token_configured
      ? `<span class="chip ok" title="HF_TOKEN is set — publishing enabled"><span class="dot"></span>HF</span>`
      : `<span class="chip" title="Set HF_TOKEN to publish models without pasting a token"><span class="dot"></span>HF token unset</span>`);
    document.getElementById("sys-chips").innerHTML = chips.join("");
  } catch { /* header chips are best-effort */ }
}

/* ================= router ================= */

const routes = {
  autopilot: renderAutopilot,
  datasets: renderDatasets,
  train: renderTrain,
  jobs: renderJobs,
  models: renderModels,
};

function navigate() {
  clearPoll();
  const parts = (location.hash || "#/autopilot").slice(2).split("/");
  const name = routes[parts[0]] ? parts[0] : "autopilot";
  document.querySelectorAll("#nav a").forEach((a) =>
    a.classList.toggle("active", a.getAttribute("href") === `#/${name}`));
  routes[name](parts.slice(1)).catch((err) => {
    view.innerHTML = `<div class="card">Failed to load: ${esc(err.message)}</div>`;
  });
}
window.addEventListener("hashchange", navigate);

/* ================= view: Autopilot ================= */

async function renderAutopilot(params) {
  if (params[0]) return renderAutopilotRun(Number(params[0]));

  const [runs, status] = await Promise.all([
    api("/api/agent/runs"), api("/api/agent/status")]);

  view.innerHTML = `
    <h1>Autopilot</h1>
    <p class="sub">Describe the model you want. The agent finds public data,
      imports it, configures training, runs it on your hardware, and registers
      the model — every artifact stays editable in the manual tabs.
      ${status.llm_planner
        ? `<span class="chip ok"><span class="dot"></span>Claude planner active</span>`
        : `Planning uses built-in heuristics; set <code>ANTHROPIC_API_KEY</code> for smarter planning.`}</p>

    <div class="card">
      <div class="field">
        <label for="goal">What do you want to build?</label>
        <textarea id="goal" placeholder="e.g. A sentiment classifier for movie reviews — or — fine-tune a small LLM to answer cooking questions"></textarea>
      </div>
      <div class="row">
        <div style="width:180px">
          <label for="max-rows">Max dataset rows</label>
          <input id="max-rows" type="number" min="50" value="5000">
          <div class="hint">Smaller = faster first result</div>
        </div>
        <div class="spacer"></div>
        <button id="go">🚀 Build my model</button>
      </div>
    </div>

    <h2>Runs</h2>
    <div class="card">${runsTable(runs)}</div>`;

  document.getElementById("go").addEventListener("click", async () => {
    const goal = document.getElementById("goal").value.trim();
    if (goal.length < 3) return toast("Describe your goal first", true);
    try {
      const run = await api("/api/agent/runs", { method: "POST",
        body: { goal, max_rows: Number(document.getElementById("max-rows").value) || null } });
      location.hash = `#/autopilot/${run.id}`;
    } catch (err) { toast(err.message, true); }
  });

  if (runs.some((r) => r.status === "running")) {
    setPoll(() => renderAutopilot(params), 4000);
  }
}

function runsTable(runs) {
  if (!runs.length) return `<div class="empty">No runs yet — describe a goal above and launch one.</div>`;
  return `<table><thead><tr><th>#</th><th>Goal</th><th>Status</th><th>Started</th></tr></thead>
    <tbody>${runs.map((r) => `
      <tr class="click" onclick="location.hash='#/autopilot/${r.id}'">
        <td>${r.id}</td><td>${esc(r.goal)}</td>
        <td>${badge(r.status)}</td><td>${fmtWhen(r.created_at)}</td>
      </tr>`).join("")}</tbody></table>`;
}

async function renderAutopilotRun(id) {
  const run = await api(`/api/agent/runs/${id}`);
  const icon = (s) => s === "failed" ? "✕" : s === "running" ? "⟳" : "✓";
  const color = (s) => s === "failed" ? "var(--critical)" : s === "running" ? "var(--accent)" : "var(--good)";

  view.innerHTML = `
    <p><a href="#/autopilot">← Autopilot</a></p>
    <h1>Run #${run.id} ${badge(run.status)}</h1>
    <p class="sub">${esc(run.goal)}</p>
    <div class="card">
      <ul class="steps">
        ${(run.steps || []).map((s) => `
          <li>
            <span class="icon" style="color:${color(s.status)}">${icon(s.status)}</span>
            <span><span class="title">${esc(s.title)}</span><br>
                  <span class="detail">${esc(s.detail)}</span></span>
          </li>`).join("") || `<li><span class="icon">⟳</span><span class="detail">Starting…</span></li>`}
      </ul>
    </div>
    <div class="row">
      ${run.dataset_id ? `<button class="ghost" onclick="location.hash='#/datasets'">View dataset #${run.dataset_id}</button>` : ""}
      ${run.job_id ? `<button class="ghost" onclick="location.hash='#/jobs/${run.job_id}'">Open training job #${run.job_id} →</button>` : ""}
      ${run.status === "succeeded" ? `<button onclick="location.hash='#/models'">Go to Models →</button>` : ""}
    </div>`;

  if (run.status === "running") setPoll(() => renderAutopilotRun(id), 2500);
}

/* ================= view: Datasets ================= */

async function renderDatasets() {
  const datasets = await api("/api/datasets");

  view.innerHTML = `
    <h1>Datasets</h1>
    <p class="sub">Pull data from public sources or bring your own. Everything
      is normalized to Parquet and profiled so training can auto-detect columns.</p>

    <div class="card">
      <h2 style="margin-top:0">Search public datasets (Hugging Face Hub)</h2>
      <div class="row">
        <div class="grow"><input id="hub-q" placeholder="e.g. movie reviews sentiment, house prices, medical questions…"></div>
        <div style="width:150px"><input id="hub-rows" type="number" min="50" placeholder="max rows (all)"></div>
        <button id="hub-search">Search</button>
      </div>
      <div id="hub-results" style="margin-top:12px"></div>
    </div>

    <div class="row">
      <div class="card grow">
        <h2 style="margin-top:0">Import from URL</h2>
        <div class="field"><input id="url-input" placeholder="https://…/data.csv (CSV, TSV, JSON, JSONL, Parquet)"></div>
        <button id="url-import" class="ghost">Import URL</button>
      </div>
      <div class="card grow">
        <h2 style="margin-top:0">Upload a file</h2>
        <div class="field"><input id="file-input" type="file"
          accept=".csv,.tsv,.json,.jsonl,.parquet,.xlsx,.xls"></div>
        <button id="file-upload" class="ghost">Upload</button>
        <div class="hint">Excel sheets welcome — first sheet is imported.</div>
      </div>
    </div>

    <h2>Imported datasets</h2>
    <div class="card">${datasetsTable(datasets)}</div>`;

  document.getElementById("hub-search").addEventListener("click", searchHub);
  document.getElementById("hub-q").addEventListener("keydown",
    (e) => { if (e.key === "Enter") searchHub(); });

  document.getElementById("url-import").addEventListener("click", async () => {
    const url = document.getElementById("url-input").value.trim();
    if (!url) return toast("Enter a URL", true);
    try {
      await api("/api/datasets/import-url", { method: "POST", body: { url } });
      toast("Import started");
      renderDatasets();
    } catch (err) { toast(err.message, true); }
  });

  document.getElementById("file-upload").addEventListener("click", async () => {
    const input = document.getElementById("file-input");
    if (!input.files.length) return toast("Choose a file", true);
    const form = new FormData();
    form.append("file", input.files[0]);
    try {
      await api("/api/datasets/upload", { method: "POST", body: form });
      toast("Uploaded");
      renderDatasets();
    } catch (err) { toast(err.message, true); }
  });

  // Wire per-row actions (preview / train / delete).
  view.querySelectorAll("[data-preview]").forEach((b) =>
    b.addEventListener("click", () => openPreview(Number(b.dataset.preview))));
  view.querySelectorAll("[data-del-ds]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this dataset and its files?")) return;
      try { await api(`/api/datasets/${b.dataset.delDs}`, { method: "DELETE" });
            renderDatasets(); } catch (err) { toast(err.message, true); }
    }));

  if (datasets.some((d) => d.status === "importing")) {
    setPoll(renderDatasets, 3000);
  }
}

function datasetsTable(datasets) {
  if (!datasets.length) return `<div class="empty">Nothing imported yet — search above or upload a file.</div>`;
  return `<table><thead><tr>
      <th>Name</th><th>Source</th><th class="num">Rows</th><th class="num">Size</th>
      <th>Status</th><th></th></tr></thead>
    <tbody>${datasets.map((d) => `
      <tr>
        <td><strong>${esc(d.name)}</strong><br><span class="hint mono">${esc(d.source_ref)}</span></td>
        <td>${esc(d.source_type)}</td>
        <td class="num">${d.num_rows ?? "—"}</td>
        <td class="num">${fmtBytes(d.size_bytes)}</td>
        <td>${badge(d.status)}${d.error ? `<div class="hint">${esc(d.error)}</div>` : ""}</td>
        <td style="white-space:nowrap">
          ${d.status === "ready" ? `
            <button class="small ghost" data-preview="${d.id}">Preview</button>
            <button class="small ghost" onclick="location.hash='#/train?dataset=${d.id}'">Train</button>` : ""}
          <button class="small ghost" data-del-ds="${d.id}">✕</button>
        </td>
      </tr>`).join("")}</tbody></table>`;
}

async function searchHub() {
  const q = document.getElementById("hub-q").value.trim();
  const box = document.getElementById("hub-results");
  if (!q) return;
  box.innerHTML = `<div class="empty">Searching the Hub…</div>`;
  try {
    const results = await api(`/api/datasets/search-hub?q=${encodeURIComponent(q)}`);
    if (!results.length) { box.innerHTML = `<div class="empty">No public datasets found.</div>`; return; }
    box.innerHTML = `<table><thead><tr><th>Dataset</th><th class="num">Downloads</th><th>Tags</th><th></th></tr></thead>
      <tbody>${results.map((r) => `
        <tr>
          <td class="mono">${esc(r.repo_id)}</td>
          <td class="num">${r.downloads?.toLocaleString() ?? "—"}</td>
          <td><span class="hint">${esc((r.tags || []).join(", "))}</span></td>
          <td><button class="small" data-import="${esc(r.repo_id)}">Import</button></td>
        </tr>`).join("")}</tbody></table>`;
    box.querySelectorAll("[data-import]").forEach((b) =>
      b.addEventListener("click", async () => {
        b.disabled = true;
        const maxRows = Number(document.getElementById("hub-rows").value) || null;
        try {
          await api("/api/datasets/import-hub", { method: "POST",
            body: { repo_id: b.dataset.import, max_rows: maxRows } });
          toast(`Importing ${b.dataset.import}…`);
          renderDatasets();
        } catch (err) { b.disabled = false; toast(err.message, true); }
      }));
  } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

async function openPreview(id) {
  try {
    const p = await api(`/api/datasets/${id}/preview?rows=20`);
    const cols = (p.columns || []).map((c) =>
      `<span class="chip" title="${esc(c.samples?.join(" · ") || "")}">${esc(c.name)}
         <span class="hint">${esc(c.dtype)}${c.n_unique != null ? ` · ${c.n_unique}${c.unique_capped ? "+" : ""} uniq` : ""}</span></span>`).join(" ");
    const names = (p.columns || []).map((c) => c.name);
    const table = `<div class="scroll-x"><table>
      <thead><tr>${names.map((n) => `<th>${esc(n)}</th>`).join("")}</tr></thead>
      <tbody>${(p.rows || []).map((row) =>
        `<tr>${names.map((n) => `<td>${esc(String(row[n] ?? "")).slice(0, 200)}</td>`).join("")}</tr>`).join("")}
      </tbody></table></div>`;
    modal(`<h3>Preview</h3>
      <p class="hint">Suggested text column: <code>${esc(p.suggested_text_column ?? "—")}</code>
         · suggested label column: <code>${esc(p.suggested_label_column ?? "—")}</code></p>
      <p>${cols}</p>${table}`);
  } catch (err) { toast(err.message, true); }
}

/* ================= view: Train (manual) ================= */

async function renderTrain(params) {
  const preselect = new URLSearchParams((params[0] || "").split("?")[1] ||
    (location.hash.split("?")[1] || "")).get("dataset");
  const [tasks, datasets] = await Promise.all([
    api("/api/system/tasks"), api("/api/datasets")]);
  const ready = datasets.filter((d) => d.status === "ready");

  view.innerHTML = `
    <h1>Train a model</h1>
    <p class="sub">Manual mode: pick data, pick a task, tune what you like —
      sensible defaults everywhere. Forms below are generated from the task
      registry, so custom tasks appear automatically.</p>
    <div class="card">
      <div class="row">
        <div class="grow field">
          <label>Job name</label>
          <input id="job-name" placeholder="my first model">
        </div>
        <div class="grow field">
          <label>Dataset</label>
          <select id="job-dataset">
            ${ready.length ? ready.map((d) =>
              `<option value="${d.id}" ${String(d.id) === preselect ? "selected" : ""}>
                 #${d.id} — ${esc(d.name)} (${d.num_rows} rows)</option>`).join("")
              : `<option value="">No ready datasets — import one first</option>`}
          </select>
        </div>
      </div>
      <div class="field">
        <label>Task</label>
        <select id="job-task">
          ${tasks.map((t) => `<option value="${esc(t.task)}" ${t.available ? "" : "disabled"}>
             ${esc(t.label)}${t.available ? "" : ` — install ${esc(t.missing_requirements.join(", "))}`}</option>`).join("")}
        </select>
        <div class="hint" id="task-desc"></div>
      </div>
      <div class="field" id="base-model-field" style="display:none">
        <label>Base model (Hugging Face id)</label>
        <input id="job-base-model">
        <div class="hint">Any compatible checkpoint from huggingface.co/models.</div>
      </div>
      <h2>Hyperparameters</h2>
      <div class="row" id="hp-fields"></div>
      <div class="row" style="margin-top:16px">
        <div class="spacer"></div>
        <button id="job-create" ${ready.length ? "" : "disabled"}>Start training</button>
      </div>
    </div>`;

  const taskSelect = document.getElementById("job-task");
  const currentSpec = () => tasks.find((t) => t.task === taskSelect.value);

  async function renderTaskFields() {
    const spec = currentSpec();
    if (!spec) return;
    document.getElementById("task-desc").textContent = spec.description;
    const bmField = document.getElementById("base-model-field");
    bmField.style.display = spec.needs_base_model ? "" : "none";
    if (spec.needs_base_model) {
      document.getElementById("job-base-model").value = spec.default_base_model || "";
    }
    // Prefill text/label column suggestions from the selected dataset.
    let suggestions = {};
    const dsId = document.getElementById("job-dataset").value;
    if (dsId) {
      try {
        const p = await api(`/api/datasets/${dsId}/preview?rows=1`);
        suggestions = { text_column: p.suggested_text_column,
                        label_column: p.suggested_label_column };
      } catch { /* suggestions are optional */ }
    }
    document.getElementById("hp-fields").innerHTML = spec.hyperparams.map((h) => {
      const value = suggestions[h.name] ?? h.default;
      const input = h.choices
        ? `<select data-hp="${esc(h.name)}">${h.choices.map((c) =>
            `<option ${c === value ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>`
        : h.type === "bool"
        ? `<select data-hp="${esc(h.name)}"><option value="true" ${value ? "selected" : ""}>yes</option>
             <option value="false" ${value ? "" : "selected"}>no</option></select>`
        : `<input data-hp="${esc(h.name)}" value="${esc(value ?? "")}"
             ${h.type !== "str" ? `type="number" step="any"` : ""}>`;
      return `<div style="width:220px" class="field">
        <label>${esc(h.name)}</label>${input}
        <div class="hint">${esc(h.help)}</div></div>`;
    }).join("");
  }

  taskSelect.addEventListener("change", renderTaskFields);
  document.getElementById("job-dataset").addEventListener("change", renderTaskFields);
  // Select the first *available* task by default.
  const firstAvailable = tasks.find((t) => t.available);
  if (firstAvailable) taskSelect.value = firstAvailable.task;
  await renderTaskFields();

  document.getElementById("job-create").addEventListener("click", async () => {
    const spec = currentSpec();
    const hyperparams = {};
    view.querySelectorAll("[data-hp]").forEach((elm) => {
      hyperparams[elm.dataset.hp] = elm.value;
    });
    try {
      const job = await api("/api/jobs", { method: "POST", body: {
        name: document.getElementById("job-name").value.trim() || "untitled job",
        dataset_id: Number(document.getElementById("job-dataset").value),
        task: spec.task,
        base_model: spec.needs_base_model
          ? document.getElementById("job-base-model").value.trim() : null,
        hyperparams,
      }});
      location.hash = `#/jobs/${job.id}`;
    } catch (err) { toast(err.message, true); }
  });
}

/* ================= view: Jobs ================= */

async function renderJobs(params) {
  if (params[0]) return renderJobDetail(Number(params[0]));
  const jobs = await api("/api/jobs");

  view.innerHTML = `
    <h1>Training jobs</h1>
    <p class="sub">Every job runs in its own process; logs and metrics stream live.</p>
    <div class="card">
      ${jobs.length ? `<table><thead><tr>
          <th>#</th><th>Name</th><th>Task</th><th>Status</th>
          <th>Duration</th><th>Started</th></tr></thead>
        <tbody>${jobs.map((j) => `
          <tr class="click" onclick="location.hash='#/jobs/${j.id}'">
            <td>${j.id}</td><td><strong>${esc(j.name)}</strong></td>
            <td><code>${esc(j.task)}</code></td>
            <td>${badge(j.status)}</td>
            <td>${fmtDuration(j.started_at, j.finished_at)}</td>
            <td>${fmtWhen(j.created_at)}</td>
          </tr>`).join("")}</tbody></table>`
        : `<div class="empty">No jobs yet — use Autopilot or the Train tab.</div>`}
    </div>`;

  if (jobs.some((j) => j.status === "running" || j.status === "queued")) {
    setPoll(() => renderJobs(params), 4000);
  }
}

/** Job detail keeps its own incremental log offset between polls. */
async function renderJobDetail(id) {
  const job = await api(`/api/jobs/${id}`);

  view.innerHTML = `
    <p><a href="#/jobs">← Jobs</a></p>
    <h1>#${job.id} ${esc(job.name)} ${badge(job.status)}</h1>
    <p class="sub"><code>${esc(job.task)}</code>
      ${job.base_model ? ` · base: <code>${esc(job.base_model)}</code>` : ""}
      · duration ${fmtDuration(job.started_at, job.finished_at)}
      ${job.error ? `<br><span style="color:var(--critical)">${esc(job.error)}</span>` : ""}</p>
    <div class="row" style="margin-bottom:14px">
      ${job.status === "running" || job.status === "queued"
        ? `<button class="danger" id="stop-job">Stop job</button>` : ""}
      ${job.status === "succeeded" ? `<button onclick="location.hash='#/models'">View in Models →</button>` : ""}
      ${["failed", "stopped", "succeeded"].includes(job.status)
        ? `<button class="ghost" id="del-job">Delete job</button>` : ""}
    </div>
    <div class="card"><h2 style="margin-top:0">Metrics</h2><div id="metrics-area"><div class="empty">No metrics yet.</div></div></div>
    <div class="card"><h2 style="margin-top:0">Log</h2><pre class="log" id="log-box"></pre></div>`;

  document.getElementById("stop-job")?.addEventListener("click", async () => {
    try { await api(`/api/jobs/${id}/stop`, { method: "POST" }); renderJobDetail(id); }
    catch (err) { toast(err.message, true); }
  });
  document.getElementById("del-job")?.addEventListener("click", async () => {
    if (!confirm("Delete this job and its outputs? Registered models keep their own copies.")) return;
    try { await api(`/api/jobs/${id}`, { method: "DELETE" }); location.hash = "#/jobs"; }
    catch (err) { toast(err.message, true); }
  });

  let logOffset = 0;
  const logBox = document.getElementById("log-box");

  async function refresh() {
    // 1. logs — incremental append via byte offset
    const log = await api(`/api/jobs/${id}/logs?offset=${logOffset}`);
    if (log.offset < logOffset) { logBox.textContent = ""; }  // log rotated/reset
    if (log.content) {
      const atBottom = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 8;
      logBox.textContent += log.content;
      if (atBottom) logBox.scrollTop = logBox.scrollHeight;
    }
    logOffset = log.offset;

    // 2. metrics — chart + tiles
    const points = await api(`/api/jobs/${id}/metrics`);
    if (points.length) renderMetricsArea(document.getElementById("metrics-area"), points, job);

    // 3. status flip -> re-render the whole page once to update buttons
    const now = await api(`/api/jobs/${id}`);
    if (now.status !== job.status) renderJobDetail(id);
  }

  await refresh().catch(() => {});
  if (job.status === "running" || job.status === "queued") {
    setPoll(refresh, 2500);
  }
}

function renderMetricsArea(container, points, job) {
  // Loss curves share a unit and therefore one axis; everything else
  // (accuracy, epoch…) is shown as stat tiles with the latest value.
  const train = points.filter((p) => typeof p.loss === "number")
                      .map((p) => ({ x: p.step ?? 0, y: p.loss }));
  const evals = points.filter((p) => typeof p.eval_loss === "number")
                      .map((p) => ({ x: p.step ?? 0, y: p.eval_loss }));

  const latest = {};
  for (const p of points) {
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === "number" && !["time", "step", "loss", "eval_loss"].includes(k)) {
        latest[k] = v;
      }
    }
  }
  Object.assign(latest, job.metrics || {});
  const tiles = Object.entries(latest)
    .filter(([, v]) => typeof v === "number")
    .slice(0, 8)
    .map(([k, v]) => `<div class="tile"><div class="k">${esc(k)}</div>
      <div class="v">${Math.abs(v) >= 1000 ? v.toLocaleString() : +v.toFixed(4)}</div></div>`)
    .join("");

  container.innerHTML = `
    ${train.length > 1 ? `
      <div class="chart-wrap">
        <canvas class="chart" id="loss-chart"></canvas>
        <div class="chart-tooltip" id="chart-tip"></div>
      </div>
      <div class="legend">
        <span><span class="swatch" style="background:${SERIES_COLORS[0]}"></span>training loss</span>
        ${evals.length ? `<span><span class="swatch" style="background:${SERIES_COLORS[1]}"></span>eval loss</span>` : ""}
      </div>` : ""}
    ${tiles ? `<div class="tiles" style="margin-top:14px">${tiles}</div>` : ""}`;

  if (train.length > 1) {
    drawLossChart(document.getElementById("loss-chart"),
      document.getElementById("chart-tip"),
      evals.length ? [{ name: "training loss", pts: train },
                      { name: "eval loss", pts: evals }]
                   : [{ name: "training loss", pts: train }]);
  }
}

/* ================= loss chart (canvas) =================
 *
 * Hand-rolled so the UI stays dependency-free. Spec follows the dataviz
 * method: fixed-order categorical slots (validated dark palette), 2px lines,
 * one shared axis (loss only), recessive hairline grid, muted tick labels,
 * crosshair + tooltip on hover.
 */

const SERIES_COLORS = ["#3987e5", "#199e70", "#c98500", "#008300"]; // fixed slot order
const CHART = { grid: "#2c2c2a", axis: "#383835", ink: "#898781" };

function drawLossChart(canvas, tip, series) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const pad = { l: 46, r: 14, t: 12, b: 24 };
  const all = series.flatMap((s) => s.pts);
  const xMin = Math.min(...all.map((p) => p.x));
  const xMax = Math.max(...all.map((p) => p.x));
  const yMax = Math.max(...all.map((p) => p.y)) * 1.06 || 1;
  const yMin = 0; // loss is non-negative; a zero baseline keeps scale honest
  const sx = (x) => pad.l + ((x - xMin) / Math.max(1e-9, xMax - xMin)) * (w - pad.l - pad.r);
  const sy = (y) => pad.t + (1 - (y - yMin) / (yMax - yMin)) * (h - pad.t - pad.b);

  // grid: 4 recessive horizontal hairlines + muted tick labels
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = CHART.ink;
  for (let i = 0; i <= 4; i++) {
    const yVal = yMin + ((yMax - yMin) * i) / 4;
    const y = sy(yVal);
    ctx.strokeStyle = i === 0 ? CHART.axis : CHART.grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(yVal >= 10 ? yVal.toFixed(0) : yVal.toFixed(2), 6, y + 4);
  }
  // x ticks: first / mid / last step (aligned inward so nothing clips)
  [xMin, (xMin + xMax) / 2, xMax].forEach((xVal, i) => {
    const label = `step ${Math.round(xVal)}`;
    const tw = ctx.measureText(label).width;
    const x = i === 0 ? sx(xVal) : i === 2 ? sx(xVal) - tw : sx(xVal) - tw / 2;
    ctx.fillText(label, x, h - 6);
  });

  // series lines: 2px, round joins, fixed slot colors
  series.forEach((s, i) => {
    ctx.strokeStyle = SERIES_COLORS[i % SERIES_COLORS.length];
    ctx.lineWidth = 2;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    s.pts.forEach((p, j) => (j ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
    ctx.stroke();
  });

  // hover: crosshair + shared tooltip at the nearest step
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = null;
    series.forEach((s, i) => s.pts.forEach((p) => {
      const d = Math.abs(sx(p.x) - mx);
      if (!best || d < best.d) best = { d, x: p.x, i, p };
    }));
    if (!best) return;
    // redraw base then crosshair + markers (cheap at these point counts)
    drawLossChart(canvas, tip, series);
    const c2 = canvas.getContext("2d");
    c2.save(); c2.scale(dpr, dpr);
    c2.strokeStyle = CHART.axis; c2.lineWidth = 1;
    c2.beginPath(); c2.moveTo(sx(best.x), pad.t); c2.lineTo(sx(best.x), h - pad.b); c2.stroke();
    const rows = [];
    series.forEach((s, i) => {
      const near = s.pts.reduce((a, p) =>
        Math.abs(p.x - best.x) < Math.abs(a.x - best.x) ? p : a, s.pts[0]);
      c2.fillStyle = SERIES_COLORS[i % SERIES_COLORS.length];
      c2.beginPath(); c2.arc(sx(near.x), sy(near.y), 4, 0, Math.PI * 2); c2.fill();
      c2.strokeStyle = "#1a1a19"; c2.lineWidth = 2; c2.stroke(); // 2px surface ring
      rows.push(`<span class="swatch" style="background:${SERIES_COLORS[i]}"></span>${esc(s.name)}: <strong>${near.y.toFixed(4)}</strong>`);
    });
    c2.restore();
    tip.innerHTML = `step ${Math.round(best.x)}<br>${rows.join("<br>")}`;
    tip.style.display = "block";
    tip.style.left = Math.min(mx + 14, w - 170) + "px";
    tip.style.top = "10px";
  };
  canvas.onmouseleave = () => { tip.style.display = "none"; drawLossChart(canvas, tip, series); };
}

/* ================= view: Models ================= */

async function renderModels() {
  const models = await api("/api/models");

  view.innerHTML = `
    <h1>Models</h1>
    <p class="sub">Every successful job registers its artifact here. Publish
      any of them to the Hugging Face Hub — private by default.</p>
    <div class="card">
      ${models.length ? `<table><thead><tr>
          <th>#</th><th>Name</th><th>Task</th><th>Metrics</th><th>Created</th>
          <th>Hugging Face</th><th></th></tr></thead>
        <tbody>${models.map((m) => `
          <tr>
            <td>${m.id}</td>
            <td><strong>${esc(m.name)}</strong>
              ${m.base_model ? `<br><span class="hint mono">${esc(m.base_model)}</span>` : ""}</td>
            <td><code>${esc(m.task)}</code></td>
            <td class="hint">${esc(metricsSummary(m.metrics))}</td>
            <td>${fmtWhen(m.created_at)}</td>
            <td>${m.published_repo
              ? `<a href="https://huggingface.co/${esc(m.published_repo)}" target="_blank" rel="noopener">${esc(m.published_repo)} ↗</a>`
              : `<button class="small" data-publish="${m.id}">Publish</button>`}</td>
            <td style="white-space:nowrap">
              <button class="small ghost" data-files="${m.id}">Files</button>
              <button class="small ghost" data-del-model="${m.id}">✕</button>
            </td>
          </tr>`).join("")}</tbody></table>`
        : `<div class="empty">No models yet — train something first.</div>`}
    </div>`;

  view.querySelectorAll("[data-publish]").forEach((b) =>
    b.addEventListener("click", () => openPublish(Number(b.dataset.publish))));
  view.querySelectorAll("[data-files]").forEach((b) =>
    b.addEventListener("click", async () => {
      const files = await api(`/api/models/${b.dataset.files}/files`);
      modal(`<h3>Artifact files</h3>
        ${files.length ? `<table><thead><tr><th>File</th><th class="num">Size</th></tr></thead>
          <tbody>${files.map((f) => `<tr><td class="mono">${esc(f.name)}</td>
            <td class="num">${fmtBytes(f.size_bytes)}</td></tr>`).join("")}</tbody></table>`
          : `<div class="empty">Directory is empty.</div>`}`);
    }));
  view.querySelectorAll("[data-del-model]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this model and its files?")) return;
      try { await api(`/api/models/${b.dataset.delModel}`, { method: "DELETE" });
            renderModels(); } catch (err) { toast(err.message, true); }
    }));
}

function metricsSummary(metrics) {
  if (!metrics) return "—";
  return Object.entries(metrics)
    .filter(([, v]) => typeof v === "number")
    .slice(0, 3)
    .map(([k, v]) => `${k}=${+Number(v).toFixed(4)}`)
    .join("  ") || "—";
}

function openPublish(id) {
  const m = modal(`
    <h3>Publish to the Hugging Face Hub</h3>
    <div class="field">
      <label>Repository id</label>
      <input id="pub-repo" placeholder="your-username/my-model">
      <div class="hint">The repo is created if it doesn't exist.</div>
    </div>
    <div class="field">
      <label>Access token</label>
      <input id="pub-token" type="password" placeholder="hf_… (leave blank to use HF_TOKEN)">
      <div class="hint">Needs the <strong>write</strong> role — create one at
        huggingface.co/settings/tokens. Used once, never stored.</div>
    </div>
    <div class="field">
      <label><input type="checkbox" id="pub-private" checked style="width:auto;margin-right:8px">Private repository</label>
    </div>
    <div class="row"><div class="spacer"></div>
      <button class="ghost" id="pub-cancel">Cancel</button>
      <button id="pub-go">Publish</button></div>`);

  m.root.querySelector("#pub-cancel").addEventListener("click", m.close);
  m.root.querySelector("#pub-go").addEventListener("click", async (e) => {
    const repo = m.root.querySelector("#pub-repo").value.trim();
    if (!repo.includes("/")) return toast("Repo id must look like username/model-name", true);
    e.target.disabled = true;
    e.target.textContent = "Uploading…";
    try {
      const model = await api(`/api/models/${id}/publish`, { method: "POST", body: {
        repo_id: repo,
        private: m.root.querySelector("#pub-private").checked,
        token: m.root.querySelector("#pub-token").value.trim() || null,
      }});
      m.close();
      toast(`Published to ${model.published_repo} 🎉`);
      renderModels();
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = "Publish";
      toast(err.message, true);
    }
  });
}

/* ================= boot ================= */

refreshSysChips();
setInterval(refreshSysChips, 10000);
navigate();
