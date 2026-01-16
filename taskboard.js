#!/usr/bin/env node
/**
 * Lightweight TASKS.md kanban board with live updates.
 * Usage: node taskboard.js [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');

const PORT = Number(process.argv[2]) || 4000;
const TASKS_PATH = path.join(__dirname, 'TASKS.md');
const CONFIG_PATH = path.join(__dirname, 'taskboard.config.json');
const DEFAULT_CONFIG = { autorunEnabled: false, claudeBin: 'claude', logPath: 'claude-runs.log' };

function parseCmd(value) {
  const parts = String(value || '').trim().match(/[^\s"']+|"([^"]*)"|'([^']*)'/g) || [];
  const cleaned = parts.map((p) => p.replace(/^"|"$/g, '').replace(/^'|'$/g, ''));
  const [cmd, ...rest] = cleaned;
  return { cmd: cmd || DEFAULT_CONFIG.claudeBin, args: rest };
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (err) {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(next) {
  const merged = { ...DEFAULT_CONFIG, ...next };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function resolveLogPath(cfg) {
  const target = cfg.logPath || DEFAULT_CONFIG.logPath;
  return path.isAbsolute(target) ? target : path.join(__dirname, target);
}

// --- Parsing helpers -------------------------------------------------------
function parseFrontMatter(text) {
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  const fm = fmMatch[1];
  const statusesLine = fm.match(/statuses:\s*(.*)/i);
  const severitiesLine = fm.match(/severities:\s*(.*)/i);
  const statuses = statusesLine ? statusesLine[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  const severities = severitiesLine ? severitiesLine[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  return { statuses, severities };
}

function extractFrontMatter(text) {
  const fmMatch = text.match(/^---\n[\s\S]*?\n---\n?/);
  return fmMatch ? fmMatch[0] : '';
}

function serializeTasks(frontMatter, tasks) {
  const ind = '    ';
  const blocks = tasks.map((t) => [
    `${t.id}. ${t.title}`,
    '',
    `${ind}Severity: ${t.severity}`,
    `${ind}Status: ${t.status}`,
    '',
    t.desc ? t.desc.split('\n').map((l) => ind + l.trimStart()).join('\n') : '',
    '',
  ].join('\n'));
  const body = blocks.join('---\n');
  const fm = frontMatter || '';
  const prefix = fm ? (fm.endsWith('\n') ? fm : `${fm}\n`) : '';
  const content = `${prefix}${body}`;
  return content.endsWith('\n') ? content : `${content}\n`;
}

function parseTasks(text) {
  const blocks = [];
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const parts = body.split(/\n---\n/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    const first = lines[0];
    const m = first.match(/^(\d+)\.\s+(.*)$/);
    if (!m) continue;
    const id = Number(m[1]);
    const title = m[2].trim();
    const severityLine = lines.find((l) => l.trim().toLowerCase().startsWith('severity:')) || '';
    const statusLine = lines.find((l) => l.trim().toLowerCase().startsWith('status:')) || '';
    const severity = (severityLine.split(':')[1] || 'UNKNOWN').split('|')[0].trim();
    const status = (statusLine.split(':')[1] || 'To Do').split('|')[0].trim();
    const desc = lines
      .filter((l, idx) => idx > 0 && !l.trim().toLowerCase().startsWith('severity:') && !l.trim().toLowerCase().startsWith('status:'))
      .join('\n')
      .trim();
    const full = trimmed;
    blocks.push({ id, title, severity, status, desc, raw: full, full });
  }
  return blocks;
}

function rebuildContent(original, tasks) {
  const pieces = [];
  let cursor = 0;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const regex = /^(\d+)\.\s+(.*?)\n([\s\S]*?)(?=\n---|\n$)/gm;
  let match;
  while ((match = regex.exec(original)) !== null) {
    const id = Number(match[1]);
    const task = byId.get(id);
    pieces.push(original.slice(cursor, match.index));
    if (!task) {
      pieces.push(match[0]);
    } else {
      const body = match[3];
      const newBody = body
        .replace(/Severity:\s*[^\n]+/i, `Severity: ${task.severity}`)
        .replace(/Status:\s*[^\n]+/i, `Status: ${task.status}`);
      pieces.push(`${id}. ${task.title}\n${newBody}`);
    }
    cursor = regex.lastIndex;
  }
  pieces.push(original.slice(cursor));
  return pieces.join('');
}

// --- SSE management --------------------------------------------------------
const clients = new Set();
function sendEvent(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

// --- File reading/updating -------------------------------------------------
function readTasks() {
  const text = fs.readFileSync(TASKS_PATH, 'utf8');
  const frontMatter = extractFrontMatter(text);
  const meta = parseFrontMatter(text);
  return { text, frontMatter, tasks: parseTasks(text), meta };
}

function updateTask(id, updates) {
  const { frontMatter, tasks } = readTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error('Task not found');
  const oldTask = tasks[idx];
  const updated = { ...oldTask, ...updates };
  const newContent = serializeTasks(frontMatter, tasks.map((t, i) => (i === idx ? updated : t)));
  fs.writeFileSync(TASKS_PATH, newContent, 'utf8');
  return { oldTask, updated };
}

function createTask(data) {
  const { frontMatter, tasks, meta } = readTasks();
  const title = String(data.title || '').trim();
  if (!title) throw new Error('Title is required');
  const maxId = tasks.reduce((m, t) => Math.max(m, t.id), 0);
  const nextId = maxId + 1;
  const status = data.status ? String(data.status).trim() : 'Backlog';
  const defaultSeverity = (meta.severities || []).find((s) => String(s).toLowerCase() === 'medium')
    || (meta.severities && meta.severities[0])
    || 'MEDIUM';
  const severity = data.severity ? String(data.severity).trim() : defaultSeverity;
  const desc = (data.desc || '').trim();

  const newTasks = [...tasks, { id: nextId, title, severity, status, desc, full: '', raw: '' }];
  const newContent = serializeTasks(frontMatter, newTasks);
  fs.writeFileSync(TASKS_PATH, newContent, 'utf8');
  return { id: nextId };
}

function deleteTask(id) {
  const { frontMatter, tasks } = readTasks();
  const exists = tasks.some((t) => t.id === id);
  if (!exists) throw new Error('Task not found');
  const remaining = tasks.filter((t) => t.id !== id);
  const newContent = serializeTasks(frontMatter, remaining);
  fs.writeFileSync(TASKS_PATH, newContent, 'utf8');
}

function normalizeStatus(status) {
  return String(status || '').trim().toLowerCase();
}

function shouldTriggerAutomation(oldTask, updated) {
  return normalizeStatus(oldTask.status) === 'backlog' && normalizeStatus(updated.status) === 'to do';
}

function triggerAutomation(oldTask, updated) {
  const config = loadConfig();
  if (!config.autorunEnabled) return;
  if (!shouldTriggerAutomation(oldTask, updated)) return;

  const { cmd: claudeBin, args: extraArgs } = parseCmd(config.claudeBin || DEFAULT_CONFIG.claudeBin);
  const logPath = resolveLogPath(config);
  const stamp = new Date().toISOString();
  fs.appendFileSync(logPath, `[${stamp}] launch /do-task ${updated.id} (${oldTask.status} -> ${updated.status})\n`);

  let out;
  try {
    out = fs.openSync(logPath, 'a');
  } catch (err) {
    console.error('[taskboard] unable to open log file', logPath, err.message);
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] log open failed: ${err.message}\n`);
    return;
  }

  try {
    const child = spawn(claudeBin, [...extraArgs, '/do-task', String(updated.id)], {
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.on('error', (err) => {
      fs.appendFile(logPath, `[${new Date().toISOString()}] spawn error: ${err.message}\n`, () => {});
    });
    child.on('exit', (code, signal) => {
      fs.appendFile(logPath, `[${new Date().toISOString()}] exit code=${code} signal=${signal || 'none'}\n`, () => {});
    });
    child.unref();
    console.log(`[taskboard] spawned Claude for #${updated.id} (${oldTask.status} -> ${updated.status}) pid=${child.pid}`);
  } catch (err) {
    console.error('[taskboard] failed to spawn Claude', err.message);
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] spawn threw: ${err.message}\n`);
  } finally {
    try {
      fs.closeSync(out);
    } catch (err) {
      console.error('[taskboard] failed closing log fd', err.message);
    }
  }
}

// --- HTTP server -----------------------------------------------------------
const server = http.createServer(async (req, res) => {
  console.log('[taskboard] request', req.method, req.url);
  const { pathname } = url.parse(req.url);

  if (pathname === '/data') {
    try {
      const { tasks, meta } = readTasks();
      console.log(`[taskboard] GET /data -> ${tasks.length} tasks`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks, meta }));
    } catch (err) {
      console.error('[taskboard] /data error', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/events') {
    console.log('[taskboard] client connected to /events');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (pathname === '/update' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const id = Number(payload.id);
        if (!id) throw new Error('Invalid id');
        const updates = {};
        if (payload.status) updates.status = payload.status;
        if (payload.severity) updates.severity = payload.severity;
        if (payload.title) updates.title = payload.title.replace(/^\s*\d+\.\s*/, '').trim();
        if (payload.desc !== undefined) updates.desc = String(payload.desc || '');
        const result = updateTask(id, updates);
        sendEvent({ type: 'refresh' });
        if (result) triggerAutomation(result.oldTask, result.updated);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/create' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = createTask({
          title: payload.title,
          severity: payload.severity,
          status: payload.status,
          desc: payload.desc,
        });
        sendEvent({ type: 'refresh' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: result.id }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const id = Number(payload.id);
        if (!id) throw new Error('Invalid id');
        deleteTask(id);
        sendEvent({ type: 'refresh' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/settings' && req.method === 'GET') {
    const cfg = loadConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cfg));
    return;
  }

  if (pathname === '/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const cfg = loadConfig();
        const next = { ...cfg };
        if (payload.hasOwnProperty('autorunEnabled')) next.autorunEnabled = !!payload.autorunEnabled;
        if (payload.claudeBin && typeof payload.claudeBin === 'string') next.claudeBin = payload.claudeBin.trim() || cfg.claudeBin;
        if (payload.logPath && typeof payload.logPath === 'string') next.logPath = payload.logPath.trim() || cfg.logPath;
        const saved = saveConfig(next);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(saved));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/app.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    return res.end(appJs());
  }

  // UI page
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    return res.end(htmlPage());
  }

  res.writeHead(404);
  res.end('Not found');
});

// Watch TASKS.md and notify clients
fs.watch(TASKS_PATH, { persistent: true }, () => {
  console.log('[taskboard] TASKS.md changed, notifying clients');
  sendEvent({ type: 'refresh' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`TASK board running at http://127.0.0.1:${PORT}`);
});

// --- HTML ------------------------------------------------------------------
function htmlPage() {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <title>TASKS.md Kanban</title>',
    '  <style>',
    '    body { margin:0; font-family: Arial, sans-serif; background:#f5f6fa; color:#222; }',
    '    header { padding:12px 16px; background:#1f2937; color:#fff; display:flex; align-items:center; gap:12px; }',
    '    .controls { display:flex; align-items:center; gap:10px; flex:1; }',
    '    .spacer { flex:1; }',
    '    .toggle { display:flex; align-items:center; gap:6px; font-size:12px; }',
    '    .toggle input { transform: scale(1.1); cursor:pointer; }',
    '    .btn { background:#2563eb; color:#fff; border:none; border-radius:4px; padding:6px 10px; cursor:pointer; font-size:12px; }',
    '    .btn:hover { background:#1d4ed8; }',
    '    .btn.secondary { background:#e5e7eb; color:#111827; }',
    '    .btn.secondary:hover { background:#d1d5db; }',
    '    .btn.danger { background:#ef4444; color:#fff; }',
    '    .btn.danger:hover { background:#dc2626; }',
    '    .modal-form { position:fixed; inset:0; background: rgba(0,0,0,0.45); display:none; align-items:center; justify-content:center; }',
    '    .modal-panel { background:#fff; width:min(520px,90vw); padding:18px; border-radius:10px; box-shadow:0 12px 30px rgba(0,0,0,0.3); display:flex; flex-direction:column; gap:12px; }',
    '    .modal-row { display:flex; flex-direction:column; gap:6px; }',
    '    .modal-row label { font-size:12px; color:#374151; }',
    '    .modal-row input, .modal-row textarea, .modal-row select { width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px; font-size:13px; }',
    '    #create-desc, #view-desc { min-height:180px; }',
    '    .modal-actions { display:flex; justify-content:flex-end; gap:8px; }',
    '    .columns { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px,1fr)); gap:12px; padding:12px; }',
    '    .col { background:#e5e7eb; border-radius:8px; padding:10px; min-height:200px; }',
    '    .col h2 { margin:0 0 8px; font-size:14px; text-transform:uppercase; letter-spacing:.5px; color:#374151; }',
    '    .card { background:#fff; border-radius:6px; padding:10px; margin-bottom:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); border-left:4px solid #3b82f6; }',
    '    .sev-CRITICAL { border-color:#ef4444; }',
    '    .sev-HIGH { border-color:#f59e0b; }',
    '    .sev-MEDIUM { border-color:#3b82f6; }',
    '    .sev-LOW { border-color:#10b981; }',
    '    .title { font-weight:700; margin-bottom:4px; }',
    '    .meta { font-size:12px; color:#4b5563; margin-bottom:6px; }',
    '    .desc { font-size:12px; white-space: pre-line; color:#111827; }',
    '    button.small { font-size:12px; padding:4px 8px; margin-right:6px; }',
    '    .modal { position:fixed; inset:0; background: rgba(0,0,0,0.45); display:none; align-items:center; justify-content:center; }',
    '    .modal-content { background:#fff; width: min(700px, 90vw); max-height:85vh; overflow:auto; padding:20px; border-radius:10px; box-shadow:0 12px 30px rgba(0,0,0,0.3); display:flex; flex-direction:column; gap:12px; }',
    '    .modal pre { white-space: pre-wrap; word-break: break-word; font-size:12px; }',
    '    .modal-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }',
    '    .close-btn { border:none; background:#ef4444; color:#fff; padding:6px 10px; border-radius:4px; cursor:pointer; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <header>',
    '    <div><strong>TASKS.md</strong> Kanban (live)</div>',
    '    <div class="controls" id="controls">',
    '      <button class="btn" id="new-task-btn">New Task</button>',
    '      <div class="spacer"></div>',
    '      <label class="toggle" id="autorun-toggle">',
    '        <input type="checkbox" id="autorun-checkbox" />',
    '        <span>Auto-run Claude</span>',
    '      </label>',
    '      <span id="status">Loading...</span>',
    '    </div>',
    '  </header>',
    '  <div class="columns" id="board"></div>',
    '  <div class="modal" id="modal" onclick="closeModal(event)">',
    '    <div class="modal-content" onclick="event.stopPropagation()">',
    '      <div class="modal-header">',
    '        <strong id="modal-title">Task</strong>',
    '        <div style="display:flex; gap:8px;">',
    '          <button class="btn danger" onclick="deleteTaskAction()">Delete</button>',
    '          <button class="btn" onclick="saveTask()">Save</button>',
    '          <button class="btn secondary" onclick="closeModal()">Close</button>',
    '        </div>',
    '      </div>',
    '      <div class="modal-row">',
    '        <label for="view-title">Title</label>',
    '        <input id="view-title" type="text" />',
    '      </div>',
    '      <div class="modal-row">',
    '        <label for="view-desc">Description</label>',
    '        <textarea id="view-desc" rows="6"></textarea>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="modal-form" id="create-modal" onclick="closeCreate(event)">',
    '    <div class="modal-panel" onclick="event.stopPropagation()">',
    '      <div style="display:flex; justify-content:space-between; align-items:center;">',
    '        <strong>Create Task</strong>',
    '        <button class="btn secondary" onclick="closeCreate()">Cancel</button>',
    '      </div>',
    '      <div class="modal-row">',
    '        <label for="create-title">Title</label>',
    '        <input id="create-title" type="text" placeholder="e.g., 5. Fix login redirect" />',
    '      </div>',
    '      <div class="modal-row">',
    '        <label for="create-severity">Severity</label>',
    '        <select id="create-severity"></select>',
    '      </div>',
    '      <div class="modal-row">',
    '        <label for="create-desc">Description</label>',
    '        <textarea id="create-desc" rows="4" placeholder="Optional details"></textarea>',
    '      </div>',
    '      <div class="modal-actions">',
    '        <button class="btn secondary" onclick="closeCreate()">Cancel</button>',
    '        <button class="btn" onclick="submitCreate()">Create</button>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <script src="/app.js"></script>',
    '</body>',
    '</html>'
  ].join('\n');
}

function appJs() {
  return [
    "console.log('[client] script start');",
    "const boardEl=document.getElementById('board');",
    "const statusEl=document.getElementById('status');",
    "const controlsEl=document.getElementById('controls');",
    "const newTaskBtn=document.getElementById('new-task-btn');",
    "const autorunCheckbox=document.getElementById('autorun-checkbox');",
    "let meta={}; let tasks=[]; let settings={autorunEnabled:false}; let nextId=1;",
    "function clearBoard(){while(boardEl.firstChild)boardEl.removeChild(boardEl.firstChild);}",
    "function createElem(tag,className,text){const el=document.createElement(tag); if(className)el.className=className; if(text!==undefined)el.textContent=text; return el;}",
    "function groupByStatus(list){const g={}; list.forEach(t=>{const k=t.status||'To Do'; (g[k]=g[k]||[]).push(t);}); return g;}",
    "function render(){clearBoard(); const g=groupByStatus(tasks); nextId=tasks.reduce((m,t)=>Math.max(m,t.id),0)+1; const defaults=(meta.statuses&&meta.statuses.length)?meta.statuses:['Backlog','To Do','In Progress','Blocked','Done']; const cols=[...defaults,...Object.keys(g).filter(k=>!defaults.includes(k))]; cols.forEach(col=>{const colEl=createElem('div','col'); colEl.dataset.status=col; colEl.addEventListener('dragover',ev=>ev.preventDefault()); colEl.addEventListener('drop',ev=>{ev.preventDefault(); const id=ev.dataTransfer.getData('text/plain'); if(id) updateTask(parseInt(id,10),{status:col});}); const items=g[col]||[]; colEl.appendChild(createElem('h2','', col + ' ('+items.length+')')); if(!items.length){colEl.appendChild(createElem('div','', 'No tasks'));} else {items.forEach(t=>colEl.appendChild(card(t)));} boardEl.appendChild(colEl);}); renderSettings();}",
    "function renderSettings(){if(!controlsEl) return; if(newTaskBtn) newTaskBtn.onclick=showCreate; if(autorunCheckbox){autorunCheckbox.checked=!!settings.autorunEnabled; autorunCheckbox.onchange=()=>updateSettings({autorunEnabled:autorunCheckbox.checked});}}",
    "function card(t){const cardEl=createElem('div','card sev-'+t.severity); cardEl.setAttribute('draggable','true'); cardEl.ondragstart=(ev)=>{ev.dataTransfer.setData('text/plain', String(t.id));}; cardEl.ondblclick=()=>viewTask(t.id); cardEl.appendChild(createElem('div','title', t.id+'. '+t.title)); const row=createElem('div'); row.style.marginTop='6px'; const b2=createElem('button','small','Set Severity'); b2.onclick=()=>changeSeverity(t.id); const b3=createElem('button','small','Open'); b3.onclick=()=>viewTask(t.id); row.append(b2,b3); cardEl.appendChild(row); return cardEl;}",
    "async function fetchData(){const res=await fetch('/data'); if(!res.ok) throw new Error('Fetch failed: '+res.status); return res.json();}",
    "async function fetchSettings(){const res=await fetch('/settings'); if(!res.ok) throw new Error('Settings fetch failed: '+res.status); settings=await res.json(); renderSettings();}",
    "async function updateSettings(payload){const res=await fetch('/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); if(!res.ok){console.error('settings update failed',res.status); return;} settings=await res.json(); renderSettings();}",
    "async function updateTask(id,payload){await fetch('/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({id},payload))}); await load();}",
    "async function changeSeverity(id){const choices=(meta.severities&&meta.severities.length)?meta.severities:['CRITICAL','HIGH','MEDIUM','LOW']; const v=prompt('Set severity for #'+id+' ('+choices.join(', ')+'):', choices[0]); if(!v) return; await updateTask(id,{severity:v});}",
    "function showCreate(){const modal=document.getElementById('create-modal'); if(!modal) return; const titleInput=document.getElementById('create-title'); const descInput=document.getElementById('create-desc'); const sevSelect=document.getElementById('create-severity'); const choices=(meta.severities&&meta.severities.length)?meta.severities:['CRITICAL','HIGH','MEDIUM','LOW']; const preferred=choices.find(c=>String(c).toLowerCase()==='medium')||choices[0]; sevSelect.innerHTML=''; choices.forEach((c)=>{const opt=document.createElement('option'); opt.value=c; opt.textContent=c; if(c===preferred) opt.selected=true; sevSelect.appendChild(opt);}); titleInput.value=nextId + '. '; descInput.value=''; modal.style.display='flex'; titleInput.focus(); titleInput.setSelectionRange(titleInput.value.length,titleInput.value.length);} ",
    "function closeCreate(){const modal=document.getElementById('create-modal'); if(modal) modal.style.display='none';}",
    "async function submitCreate(){const title=document.getElementById('create-title').value; const severity=document.getElementById('create-severity').value; const desc=document.getElementById('create-desc').value; const res=await fetch('/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'Backlog', title, severity, desc})}); if(!res.ok){alert('Create failed: '+res.status); return;} closeCreate(); await load();}",
    "async function createTask(payload){const res=await fetch('/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({status:'Backlog'},payload))}); if(!res.ok){alert('Create failed: '+res.status); return;} await load();}",
    "async function load(){console.log('[client] load start'); statusEl.textContent='Refreshing...'; try{const data=await fetchData(); meta=data.meta||{}; tasks=data.tasks||[]; console.log('[client] tasks loaded',tasks.length,tasks); render(); statusEl.textContent='Tasks: '+tasks.length+' | Last update: '+new Date().toLocaleTimeString();}catch(e){statusEl.textContent='Error: '+e.message; console.error(e);}}",
    "fetchSettings().catch((e)=>console.error(e));",
    "load();",
    "const es=new EventSource('/events'); es.onmessage=()=>{console.log('[client] sse refresh'); load();}; es.onerror=()=>{statusEl.textContent='SSE disconnected. Retrying...';};",
    "setInterval(()=>{load();},5000);",
    "let currentId=null;",
    "function viewTask(id){const t=tasks.find(x=>x.id===id); if(!t) return; currentId=id; document.getElementById('modal-title').textContent='Task #'+t.id; const titleInput=document.getElementById('view-title'); const descInput=document.getElementById('view-desc'); if(titleInput) titleInput.value=t.id+'. '+t.title; if(descInput) descInput.value=t.desc||t.full||t.raw||''; document.getElementById('modal').style.display='flex'; if(titleInput){titleInput.focus(); titleInput.setSelectionRange(titleInput.value.length,titleInput.value.length);} }",
    "function closeModal(){document.getElementById('modal').style.display='none';}",
    "async function saveTask(){if(currentId==null) return; const titleInput=document.getElementById('view-title'); const descInput=document.getElementById('view-desc'); const payload={}; if(titleInput) payload.title=titleInput.value; if(descInput) payload.desc=descInput.value; await updateTask(currentId,payload); closeModal();}",
    "async function deleteTaskAction(){if(currentId==null) return; if(!confirm('Delete this task?')) return; await fetch('/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:currentId})}); closeModal(); await load();}",
    "window.viewTask=viewTask; window.closeModal=closeModal; window.saveTask=saveTask; window.deleteTaskAction=deleteTaskAction;"
  ].join('\n');
}
