require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');


const app = express();
// This server exposes LOCAL-ONLY, unauthenticated, powerful endpoints (run arbitrary Python, pip,
// read/write files). It must never be reachable cross-origin or off-box. Instead of wide-open CORS,
// require the Host header to be loopback — blocks DNS-rebinding (Host=attacker.com) and, together with
// the 127.0.0.1 bind below, direct LAN access (Host=<lan-ip>). The renderer is same-origin (packaged:
// 127.0.0.1:<port>; dev: Vite proxies with changeOrigin so Host=localhost), so no CORS header is needed.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function isLoopbackHost(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}
app.use((req, res, next) => {
  if (isLoopbackHost(req)) return next();
  return res.status(403).json({ error: 'forbidden: local-only server' });
});
app.use(express.json({ limit: '30mb' })); // allow base64 image uploads

// ─── Static frontend serving (Electron / packaged desktop build) ────────────────
// In dev the Vite server hosts the frontend and proxies /api here. In the packaged
// Electron app there is no Vite: this server hosts the built `dist/` itself so the
// renderer loads from http://127.0.0.1:<port> on the SAME origin as /api. The COOP/COEP
// headers mirror vite.config.js — they are REQUIRED for the SharedArrayBuffer that powers
// Pyodide's interrupt buffer (Stop button) and must be present on every document/asset.
const STATIC_DIR = process.env.BLOCKPY_STATIC_DIR;
if (STATIC_DIR && fs.existsSync(STATIC_DIR)) {
  app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    next();
  });
  app.use(express.static(STATIC_DIR));
  console.log(`🖥️  Serving built frontend from: ${STATIC_DIR}`);
}

// Workspace directory on real disk — the project root the user sees in the file explorer.
// It is the working directory for shell-run Python, so cv2.imread('name.jpg'), open('data.txt'),
// cv2.imwrite('out.png') etc. all resolve against (and appear in) this folder. Uploaded images
// land here too. Override with BLOCKPY_WORKSPACE; defaults to ~/BlockPyWorkspace.
const WORKSPACE_DIR = process.env.BLOCKPY_WORKSPACE || path.join(os.homedir(), 'BlockPyWorkspace');
try { fs.mkdirSync(WORKSPACE_DIR, { recursive: true }); } catch (_) {}
// MEDIA_DIR kept as an alias for existing call sites (uploads, seed images, run cwd).
const MEDIA_DIR = WORKSPACE_DIR;
// Platform runtime modules importable from any workspace (e.g. `import tm`) — put on PYTHONPATH.
// Use genBase() so the packaged app points at app.asar.unpacked/runtime (asarUnpack'd): the
// external python process can't read files inside app.asar. In dev genBase()==__dirname (no-op).
const RUNTIME_DIR = path.join(genBase(), 'runtime');

// Resolve a client-supplied relative path INSIDE the workspace, rejecting traversal/absolute
// escapes. Returns the absolute path, or null if it would leave the workspace.
function safeResolve(relPath) {
  const rel = String(relPath == null ? '' : relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(WORKSPACE_DIR, rel);
  const root = path.resolve(WORKSPACE_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

const PYTHON_CMD = process.env.PYTHON_CMD || (process.platform === 'win32' ? 'python' : 'python3');

// Kill a spawned python AND anything it spawned. On win32 child.kill() only signals the direct
// process (grandchildren survive), so take down the whole tree with taskkill; elsewhere SIGKILL.
function killTree(child) {
  if (!child || child.killed || child.pid == null) return;
  try {
    if (process.platform === 'win32') {
      // no-op 'error' handler: an unhandled ChildProcess 'error' would itself crash the process
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        .on('error', () => { try { child.kill(); } catch (_) {} });
    } else {
      child.kill('SIGKILL');
    }
  } catch (_) {
    try { child.kill(); } catch (_) {}
  }
}

// ─── 공용: 짧은 파이썬 조각 실행 / JSON 응답 파싱 / 원자적 JSON 쓰기 ──────────────
// 왜 필요한가: 카메라 점검·안전 정지·tensorflow 확인처럼 "한 번 돌리고 JSON 한 줄 받는" 일이
// 여러 곳에서 필요하다. 실행 방식은 /api/run-python 과 **동일**해야 한다(PYTHON_CMD +
// RUNTIME_DIR 을 PYTHONPATH 에 실어 플랫폼 런타임 import 가능, UTF-8 고정). 그래야 학생
// 코드가 도는 환경과 서버가 점검하는 환경이 어긋나지 않는다.
// 반드시 타임아웃 + killTree 로 끝난다 — 좀비 파이썬이 남으면 카메라/로봇을 물고 놓지 않는다.
// done 은 정확히 한 번만 호출된다(error/close/timeout 경합 방지).
function runPythonSnippet(code, opts, done) {
  const timeoutMs = (opts && opts.timeoutMs) || 15000;
  const file = path.join(os.tmpdir(), `blockpy_snip_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
  let settled = false;
  let timer = null;
  const cleanup = () => { try { fs.unlinkSync(file); } catch (_) {} };
  const settle = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cleanup();
    try { done(result); } catch (e) { console.log('[python-snippet] handler error:', e && e.message); }
  };
  try { fs.writeFileSync(file, code, 'utf8'); }
  catch (e) { settle({ ok: false, timedOut: false, error: `임시 파일 쓰기 실패: ${e.message}`, stdout: '', stderr: '' }); return null; }

  let child;
  try {
    child = spawn(PYTHON_CMD, ['-u', file], {
      cwd: WORKSPACE_DIR,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
        PYTHONPATH: [RUNTIME_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
    });
  } catch (e) {
    settle({ ok: false, timedOut: false, error: `python 실행 실패: ${e.message}`, stdout: '', stderr: '' });
    return null;
  }

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; if (out.length > 200000) out = out.slice(-200000); });
  child.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-200000); });
  child.on('error', (e) => settle({ ok: false, timedOut: false, error: `python 실행 오류: ${e.message}`, stdout: out, stderr: err }));
  child.on('close', (codeNum) => { cleanup(); settle({ ok: true, timedOut: false, code: codeNum, stdout: out, stderr: err }); });
  timer = setTimeout(() => {
    killTree(child);
    settle({ ok: false, timedOut: true, error: `시간초과(${timeoutMs}ms)`, stdout: out, stderr: err });
  }, timeoutMs);
  if (timer.unref) timer.unref(); // 서버/테스트 종료를 막지 않게
  return child;
}

// 스크립트가 찍은 마지막 JSON 한 줄을 고른다(파이썬 경고·TF 잡음이 섞여도 안전하게).
function lastJsonLine(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const v = JSON.parse(lines[i]);
      if (v && typeof v === 'object') return v;
    } catch (_) { /* 다음 줄 시도 */ }
  }
  return null;
}

// 원자적 JSON 쓰기(임시파일 → rename). 왜: 앱이 1초마다 상태를 덮어쓰는데, 그 순간 학생이
// 파일을 열어 보거나 전원이 나가면 반쯤 쓰인 JSON 이 남는다. rename 은 같은 볼륨에서 원자적이다.
// 사람이 읽을 수 있게 들여쓰기 2 + UTF-8.
function writeJsonAtomic(absPath, value) {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, absPath); // win32 의 fs.rename 도 기존 파일을 덮어쓴다(MOVEFILE_REPLACE_EXISTING)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw e;
  }
}

// ─── blockpy-gen introspection (ESM, lazy-imported into this CJS server) ───────
// /api/blockify turns an importable module into a LibrarySpec by importing it in a python
// subprocess (executes its top-level code) — the SAME trust level the app already grants
// /api/run-python and /api/pip-install. BLOCKIFY_ALLOW (comma-separated) optionally restricts
// which modules may be introspected; unset = allow any (local single-user posture).
const { pathToFileURL } = require('url');
// In the packaged Electron app __dirname lives inside app.asar, but blockpy-gen is asarUnpack'd
// (dynamic import()/spawn of files inside an asar fails). Redirect to the on-disk unpacked copy.
// In dev __dirname is the repo root, so this is a no-op.
function genBase() {
  let base = __dirname;
  if (base.includes('app.asar') && !base.includes('app.asar.unpacked')) {
    base = base.replace('app.asar', 'app.asar.unpacked');
  }
  return base;
}
let _introspectPromise = null;
function getIntrospect() {
  if (!_introspectPromise) {
    const url = pathToFileURL(path.join(genBase(), 'blockpy-gen', 'src', 'introspect', 'introspect.js')).href;
    // On rejection, clear the cache and rethrow — otherwise one transient EBUSY/EPERM (antivirus
    // scan, asar extraction race) would brick /api/blockify until the app restarts.
    _introspectPromise = import(url).then((m) => m.introspectModule).catch((e) => {
      _introspectPromise = null;
      throw e;
    });
  }
  return _introspectPromise;
}
const BLOCKIFY_ALLOW = (process.env.BLOCKIFY_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);
const _blockifyCache = new Map();
// Accepts a dotted import path (numpy, PIL.Image) OR a pip distribution name with dashes
// (opencv-python, scikit-learn) — _inspect.py resolves a distribution name to its real import.
const MODULE_PATH_RE = /^[A-Za-z0-9_]+([.-][A-Za-z0-9_]+)*$/;
if (BLOCKIFY_ALLOW.length === 0) {
  console.warn('[blockify] No BLOCKIFY_ALLOW set — /api/blockify will import ANY requested module (executes top-level code). Local single-user use only; set BLOCKIFY_ALLOW=mod1,mod2 to restrict.');
}

// Seed a synthetic sample image into the demo filenames using the real local cv2, so
// OpenCV examples produce output in shell mode even before any upload (best-effort).
function seedSampleImages() {
  const py = [
    'import cv2, numpy as np, os',
    `d = r"${MEDIA_DIR.replace(/\\/g, '\\\\')}"`,
    'img = np.full((240,320,3), 30, np.uint8)',
    'cv2.rectangle(img,(40,50),(150,170),(0,0,255),-1)',
    'cv2.circle(img,(230,110),55,(0,200,0),-1)',
    'cv2.putText(img,"BlockPy",(30,215),cv2.FONT_HERSHEY_SIMPLEX,1.0,(255,255,255),2)',
    'for f in ["sample.jpg"]:',
    '    p=os.path.join(d,f)',
    '    if not os.path.exists(p): cv2.imwrite(p,img)',
  ].join('\n');
  const f = path.join(os.tmpdir(), `blockpy_seed_${Date.now()}.py`);
  try {
    fs.writeFileSync(f, py, 'utf8');
    const c = spawn(PYTHON_CMD, [f], { env: process.env });
    c.on('close', () => { try { fs.unlinkSync(f); } catch (_) {} });
    c.on('error', () => { try { fs.unlinkSync(f); } catch (_) {} });
  } catch (_) {}
}

// Seed a friendly starter file the first time the workspace is empty, so the explorer
// isn't blank on first run. Never overwrites existing user files.
function seedStarterFile() {
  try {
    const f = path.join(WORKSPACE_DIR, 'main.py');
    if (fs.existsSync(f)) return;
    const hasAny = fs.readdirSync(WORKSPACE_DIR).some((n) => n.endsWith('.py'));
    if (hasAny) return;
    fs.writeFileSync(f, [
      '# Welcome to BlockPy! This file lives in your workspace folder.',
      '# Files you read/write run from here, e.g. cv2.imread("sample.jpg").',
      '',
      'print("Hello from BlockPy")',
      '',
      'for i in range(3):',
      '    print("count", i)',
      '',
    ].join('\n'), 'utf8');
  } catch (_) {}
}

// AGENTS.md/CLAUDE.md + examples 를 워크스페이스에 멱등 시딩 — 터미널의 AI 에이전트가
// 플랫폼 목적·API·규칙을 자동으로 읽게 한다. 없을 때만 쓰고 사용자 파일은 절대 안 덮는다.
function seedAgentContext() {
  try {
    // 1) AGENTS.md (리포 agent-context/ 템플릿 복사)
    const agentsSrc = path.join(__dirname, 'agent-context', 'AGENTS.md');
    const agentsDst = path.join(WORKSPACE_DIR, 'AGENTS.md');
    if (fs.existsSync(agentsSrc) && !fs.existsSync(agentsDst)) {
      fs.copyFileSync(agentsSrc, agentsDst);
    }
    // 2) CLAUDE.md — Claude Code 가 AGENTS.md 를 읽도록 @import 한 줄
    const claudeDst = path.join(WORKSPACE_DIR, 'CLAUDE.md');
    if (!fs.existsSync(claudeDst)) {
      fs.writeFileSync(claudeDst,
        '# CLAUDE.md\n이 폴더의 AI 도우미 안내는 AGENTS.md 를 따른다.\n@AGENTS.md\n', 'utf8');
    }
    // 2-b) opencode.jsonc — AI 도우미가 쓸 모델을 못 박는다. 사내 정책상 DeepSeek V4 Flash/Pro
    //      두 종만 허용되므로 기본값을 flash 로 둔다. 사용자가 이미 만든 파일은 덮지 않는다.
    const ocSrc = path.join(__dirname, 'agent-context', 'opencode.jsonc');
    const ocDst = path.join(WORKSPACE_DIR, 'opencode.jsonc');
    if (fs.existsSync(ocSrc) && !fs.existsSync(ocDst)) {
      fs.copyFileSync(ocSrc, ocDst);
    }
    // 3) 커리큘럼 예제 복사 (dev: public/examples, 패키징: dist/examples = STATIC_DIR/examples)
    const exSrc = (STATIC_DIR && fs.existsSync(path.join(STATIC_DIR, 'examples')))
      ? path.join(STATIC_DIR, 'examples')
      : path.join(__dirname, 'public', 'examples');
    // 여기 없는 예제는 워크스페이스로 복사되지 않아 **AI 도우미가 볼 수 없다**(전에 *_blocks.py 가
    // 빠져 같은 문제가 있었다). 예제를 새로 만들면 반드시 이 목록에 추가할 것.
    const NAMES = ['m1_ai_sorting_blocks.py', 'm2_gesture_rps_blocks.py',
      'm1_ai_sorting.py', 'm2_gesture_rps.py',
      'h1_nl_control.py', 'h2_teleop.py', 'h3_vision_drive.py',
      // 단계별(누적) 수업 예제 — 중등 m1/m2, 고등 h1~h3 각 3단계.
      'm1_1_찾기.py', 'm1_2_잡기.py', 'm1_3_놓기.py',
      'm2_1_손보기.py', 'm2_2_응수하기.py', 'm2_3_대전하기.py',
      'h1_1_알아듣기.py', 'h1_2_움직이기.py', 'h1_3_대화하기.py',
      'h2_1_배우기.py', 'h2_2_움직이기.py', 'h2_3_조종하기.py',
      'h3_1_배우기.py', 'h3_2_고르기.py', 'h3_3_달리기.py'];
    if (fs.existsSync(exSrc)) {
      const exDst = path.join(WORKSPACE_DIR, 'examples');
      fs.mkdirSync(exDst, { recursive: true });
      for (const n of NAMES) {
        const s = path.join(exSrc, n), d = path.join(exDst, n);
        if (fs.existsSync(s) && !fs.existsSync(d)) fs.copyFileSync(s, d);
      }
    }
  } catch (e) { console.log('[grounding] seed skipped:', e.message); }
}

// ─── MiniMax API Key Pool (Round-Robin) ───────────────────────────────────────
// Keys come from (in order): the dev .env (MINIMAX1~4), a writable per-machine config the in-app
// Settings panel saves (BLOCKPY_CONFIG, set by Electron to userData), and an optional read-only
// config you can pre-seed next to the .exe (BLOCKPY_CONFIG_RO). NOTHING is baked into the build —
// a distributed .exe ships with zero keys, so a key is never extractable from the binary.
let MINIMAX_KEYS = [];

// The single writable config the Settings panel POSTs to. Electron points this at userData; dev
// falls back to a gitignored file in the cwd.
function primaryConfigPath() {
  return process.env.BLOCKPY_CONFIG || path.join(process.cwd(), 'blockpy-config.json');
}

// All config files we READ keys from (writable primary + optional alongside-exe read-only seed).
function configPaths() {
  const out = [primaryConfigPath()];
  if (process.env.BLOCKPY_CONFIG_RO) out.push(process.env.BLOCKPY_CONFIG_RO);
  return out;
}

// A config file is JSON: { "keys": ["sk-...", ...] } (also accepts MINIMAX1..4 keys). Missing/bad → [].
function keysFromFile(p) {
  try {
    if (!p || !fs.existsSync(p)) return [];
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(raw.keys)) return raw.keys.filter(Boolean);
    return [raw.MINIMAX1, raw.MINIMAX2, raw.MINIMAX3, raw.MINIMAX4].filter(Boolean);
  } catch (_) { return []; }
}

let keyIndex = 0;
function loadKeys() {
  const envKeys = [process.env.MINIMAX1, process.env.MINIMAX2, process.env.MINIMAX3, process.env.MINIMAX4].filter(Boolean);
  const fileKeys = configPaths().flatMap(keysFromFile);
  MINIMAX_KEYS = [...new Set([...envKeys, ...fileKeys].map((k) => String(k).trim()).filter(Boolean))];
  keyIndex = 0;
  return MINIMAX_KEYS;
}
loadKeys();

if (MINIMAX_KEYS.length === 0) {
  console.error('[MiniMax] ⚠️  No API keys yet (env/.env or config). Set one in the app Settings — AI endpoints stay 503 until then.');
}

function getNextKey() {
  const key = MINIMAX_KEYS[keyIndex % MINIMAX_KEYS.length];
  keyIndex++;
  return key;
}

// Build an Anthropic client pointed at MiniMax's Anthropic-compatible endpoint
function createMiniMaxClient() {
  return new Anthropic({
    apiKey: getNextKey(),
    baseURL: 'https://api.minimax.io/anthropic',
  });
}

const MINIMAX_MODEL = 'MiniMax-M2.7';

// ─── Helper: stream thinking + text blocks from MiniMax response ─────────────
async function callMiniMax(systemPrompt, userContent, opts = {}) {
  const client = createMiniMaxClient();
  const message = await client.messages.create({
    model: MINIMAX_MODEL,
    max_tokens: opts.maxTokens || 2048,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: userContent }]
      }
    ]
  });

  let thinkingText = '';
  let responseText = '';

  for (const block of message.content) {
    if (block.type === 'thinking') thinkingText += block.thinking;
    else if (block.type === 'text') responseText += block.text;
  }

  return { thinkingText, responseText };
}


// ─── AI key config (in-app Settings) ─────────────────────────────────────────
// Local-only (the server binds 127.0.0.1). GET returns STATUS ONLY — raw keys never leave the box,
// just a masked preview. POST saves keys to the per-machine config file and reloads the pool.
app.get('/api/ai-config', (req, res) => {
  res.json({
    configured: MINIMAX_KEYS.length > 0,
    count: MINIMAX_KEYS.length,
    masked: MINIMAX_KEYS.map((k) => (k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '••••')),
    configPath: primaryConfigPath(),
    model: MINIMAX_MODEL,
  });
});

app.post('/api/ai-config', (req, res) => {
  const { keys, key } = req.body || {};
  let list = Array.isArray(keys) ? keys : (key != null ? [key] : null);
  if (!list) return res.status(400).json({ error: 'provide {keys:[...]} or {key:"..."}' });
  list = list.map((s) => String(s).trim()).filter(Boolean).slice(0, 8);   // cap the pool
  const p = primaryConfigPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ keys: list }, null, 2), 'utf8');
  } catch (e) {
    return res.status(500).json({ error: `could not write config: ${e.message}` });
  }
  loadKeys();
  res.json({ success: true, configured: MINIMAX_KEYS.length > 0, count: MINIMAX_KEYS.length, configPath: p });
});



// ─── 3.5 Blockify: introspection-based library blocks (no AI cost) ────────────
// Real-API ground truth: imports the module in a python subprocess and returns a LibrarySpec
// the frontend maps to libRegistry blocks (src/utils/libImport.js). No MiniMax involved.
app.post('/api/blockify', async (req, res) => {
  const moduleName = ((req.body && req.body.module) || '').trim();
  const includePrivate = !!(req.body && req.body.includePrivate);
  const maxEntries = Math.min(Number((req.body && req.body.maxEntries) || 1000) || 1000, 3000);
  if (!moduleName) return res.status(400).json({ error: 'module is required' });
  if (!MODULE_PATH_RE.test(moduleName)) return res.status(400).json({ error: 'invalid module name' });
  if (BLOCKIFY_ALLOW.length && !BLOCKIFY_ALLOW.includes(moduleName)) {
    return res.status(403).json({ error: `module '${moduleName}' not in BLOCKIFY_ALLOW` });
  }
  const key = `${moduleName}|${includePrivate ? 'p' : ''}|${maxEntries}`;
  if (!(req.body && req.body.refresh) && _blockifyCache.has(key)) {
    return res.json({ success: true, cached: true, spec: _blockifyCache.get(key) });
  }
  try {
    const introspect = await getIntrospect();
    const spec = await introspect(moduleName, { python: PYTHON_CMD, includePrivate, maxEntries });
    _blockifyCache.set(key, spec);
    res.json({ success: true, cached: false, spec });
  } catch (e) {
    console.error('[/api/blockify]', e.message);
    const msg = String(e.message || e);
    // _inspect.py exits 1 with a "ModuleNotFoundError: No module named '<x>'" traceback on stderr
    // for a missing module, and introspect.js folds that stderr into the rejection message. 404 lets
    // the frontend cache "definitively not installed"; anything else stays 500 (transient/broken).
    if (/ModuleNotFoundError|No module named/i.test(msg)) {
      return res.status(404).json({ success: false, notFound: true, error: msg });
    }
    res.status(500).json({ success: false, error: msg });
  }
});

// Installed DIRECT dependencies of a distribution, mapped to import names (pyserial->serial).
// Lets a `pip install <pkg>` also blockify what it pulled in. Metadata only — no import/AI.
app.post('/api/deps', (req, res) => {
  const moduleName = ((req.body && req.body.module) || '').trim();
  if (!moduleName) return res.status(400).json({ error: 'module is required' });
  if (!MODULE_PATH_RE.test(moduleName)) return res.status(400).json({ error: 'invalid module name' });
  const f = path.join(genBase(), 'blockpy-gen', 'src', 'introspect', '_deps.py');
  let child;
  // stdin 'ignore' (the script never reads it); UTF-8 env so metadata survives cp949 consoles.
  try {
    child = spawn(PYTHON_CMD, [f, moduleName], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
  }
  catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  // Settle-once guard: a failed spawn fires BOTH 'error' AND 'close', and the timeout races with
  // 'close' — replying twice throws ERR_HTTP_HEADERS_SENT and kills the whole (Electron) process.
  let responded = false;
  let timer = null;
  const reply = (status, body) => {
    if (responded) return;
    responded = true;
    clearTimeout(timer);
    res.status(status).json(body);
  };
  timer = setTimeout(() => { killTree(child); reply(500, { error: 'deps lookup timed out (30s)' }); }, 30000);
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => reply(500, { error: String(e.message || e) }));
  child.on('close', (code) => {
    if (code !== 0) return reply(500, { error: err.trim() || ('exit ' + code) });
    try { reply(200, { success: true, ...JSON.parse(out) }); }
    catch (e) { reply(500, { error: 'bad deps output: ' + e.message }); }
  });
});

// Importable SUBMODULES of a package (serial -> serial.tools.list_ports, serial.threaded, ...), so
// the app can OPT IN to blockifying a whole package tree. Enumeration only NAMES leaf modules; the
// frontend introspects each. Metadata + pkgutil only — no arbitrary import beyond sub-PACKAGE __init__.
app.post('/api/submodules', (req, res) => {
  const moduleName = ((req.body && req.body.module) || '').trim();
  const max = Math.min(Number((req.body && req.body.max) || 60) || 60, 300);
  if (!moduleName) return res.status(400).json({ error: 'module is required' });
  if (!MODULE_PATH_RE.test(moduleName)) return res.status(400).json({ error: 'invalid module name' });
  const f = path.join(genBase(), 'blockpy-gen', 'src', 'introspect', '_submodules.py');
  let child;
  try {
    child = spawn(PYTHON_CMD, [f, moduleName, `--max=${max}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
  }
  catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  let responded = false;
  let timer = null;
  const reply = (status, body) => {
    if (responded) return;
    responded = true;
    clearTimeout(timer);
    res.status(status).json(body);
  };
  timer = setTimeout(() => { killTree(child); reply(500, { error: 'submodule enumeration timed out (30s)' }); }, 30000);
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => reply(500, { error: String(e.message || e) }));
  child.on('close', (code) => {
    if (code !== 0) return reply(500, { error: err.trim() || ('exit ' + code) });
    try { reply(200, { success: true, ...JSON.parse(out) }); }
    catch (e) { reply(500, { error: 'bad submodules output: ' + e.message }); }
  });
});

// Tier-2 receiver-type oracle: Jedi infers the class of each attribute receiver in the code (static,
// no execution). Feeds the DISPLAY layer only (precise property colouring + registering the resolved
// class), so a wrong/absent inference is harmless. Degrades to {available:false} without Jedi.
app.post('/api/infer-types', (req, res) => {
  const code = (req.body && req.body.code) || '';
  if (typeof code !== 'string' || !code.trim()) return res.json({ available: true, vars: {} });
  const f = path.join(genBase(), 'blockpy-gen', 'src', 'introspect', '_infertypes.py');
  let child;
  // stdin stays a pipe — _infertypes.py reads the code from it (written + ended below). UTF-8 env
  // so Korean source doesn't mojibake through cp949 and silently empty the Jedi oracle.
  try { child = spawn(PYTHON_CMD, [f], { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }); }
  catch (e) { return res.json({ available: false, vars: {} }); }
  // Settle-once guard (see /api/deps): 'error' + 'close' both fire on a failed spawn, and the
  // timeout races with 'close' — exactly one JSON reply ever goes out.
  let responded = false;
  let timer = null;
  const reply = (body) => {
    if (responded) return;
    responded = true;
    clearTimeout(timer);
    res.json(body);
  };
  timer = setTimeout(() => { killTree(child); reply({ available: false, vars: {} }); }, 15000);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => {}); // drain — an undrained pipe deadlocks the child past ~64KB of warnings
  child.on('error', () => reply({ available: false, vars: {} }));
  child.on('close', () => { try { reply(JSON.parse(out)); } catch (_) { reply({ available: false, vars: {} }); } });
  try { child.stdin.write(code); child.stdin.end(); } catch (_) { /* child died — 'close' handles it */ }
});

// ─── 3.6 Abstract library by purpose (LLM curation + macros, grounded) ────────
// Given an introspected LibrarySpec (ground truth) + a purpose, MiniMax SELECTS a relevant
// subset, GROUPS + RELABELS it, and proposes composite MACROS — but only references real
// entries; the server drops any hallucinated ref so signatures always come from introspection.
function describeSpecEntry(spec, e) {
  const ps = (e.params || []).map((p) => {
    const star = p.kind === 'vararg' ? '*' : p.kind === 'kwarg' ? '**' : '';
    return star + p.name + (p.hasDefault ? '=…' : '');
  }).join(', ');
  const qn = e.qualName || (e.kind === 'method' ? `${spec.module}.${e.owner}.${e.name}` : `${spec.module}.${e.name}`);
  const kind = e.kind === 'method' ? 'method' : e.kind === 'class' ? 'class' : 'func';
  return `- [${kind}] ${qn}(${ps}) -> ${e.returns === false ? 'stmt' : 'value'}`;
}

// School-level abstraction knob: same library, different granularity (초=angle-only, 고=PWM/timing).
const CURATE_LEVELS = {
  beginner: { cap: 8, guide:
    'AUDIENCE: elementary students (초등). Pick the FEWEST, most INTUITIVE HIGH-LEVEL operations (e.g. "move to angle", not "set PWM pulse width"). HIDE low-level/timing/register/config/tuning operations. Prefer wrapping multi-step workflows into MACROS so one block does a whole task. Labels: plain everyday words, no jargon.' },
  intermediate: { cap: 16, guide:
    'AUDIENCE: middle-school students (중등). Pick common operations with a few key parameters exposed. A couple of macros for frequent workflows. Labels: clear, lightly technical.' },
  advanced: { cap: 34, guide:
    'AUDIENCE: high-school / advanced students (고등). Expose the FULLER API INCLUDING lower-level control (timing/PWM/config/tuning parameters). FEWER macros — prefer primitives so learners compose themselves. Labels: precise, technical.' },
};
function normLevel(x) {
  const s = String(x || '').toLowerCase();
  if (s === '초' || s.startsWith('beg') || s.startsWith('element')) return 'beginner';
  if (s === '고' || s.startsWith('adv') || s.startsWith('high')) return 'advanced';
  return 'intermediate';
}
// The representable arity of an entry (for deterministic macro checking). Methods carry the receiver
// as the macro step's first arg, so callable args = step.args minus the receiver.
function entryArity(e) {
  const ps = e.params || [];
  const pos = ps.filter((p) => p.kind === 'positional' || p.kind === 'keyword');
  return { isMethod: e.kind === 'method', required: pos.filter((p) => !p.hasDefault).length, total: pos.length, vararg: ps.some((p) => p.kind === 'vararg') };
}

app.post('/api/abstract-library', async (req, res) => {
  const { spec, purpose, max, level } = req.body || {};
  if (!spec || typeof spec.module !== 'string' || !Array.isArray(spec.entries)) {
    return res.status(400).json({ error: 'a LibrarySpec {module, entries[]} is required (call /api/blockify first)' });
  }
  if (!purpose || !String(purpose).trim()) return res.status(400).json({ error: 'purpose is required' });
  if (MINIMAX_KEYS.length === 0) return res.status(503).json({ error: 'No MiniMax API keys configured.' });

  const lvl = normLevel(level);
  const lvlCfg = CURATE_LEVELS[lvl];
  const limit = Math.min(Number(max) || lvlCfg.cap, 40);
  const entries = spec.entries;
  const refOf = (e) => e.qualName || (e.kind === 'method' ? `${spec.module}.${e.owner}.${e.name}` : `${spec.module}.${e.name}`);
  // Indexed menu (technique A: the model returns INTEGER indices, so it CANNOT reference a name that
  // isn't in the list). Each line carries the first docstring line (technique B: semantic grounding).
  const apiText = entries.map((e, i) => {
    const base = describeSpecEntry(spec, e).replace(/^- /, '');
    const doc = (e.doc || '').split('\n')[0].trim();
    return `[${i}] ${base}${doc ? '  // ' + doc.slice(0, 100) : ''}`;
  }).join('\n');

  const systemPrompt = `You curate a Python library's REAL API (ground truth) into a small, purpose-focused set of visual blocks for students.

${lvlCfg.guide}

Respond in STRICT JSON only — no markdown. Reference every API item by its integer INDEX "i" from the list (NEVER names/signatures). Schema:
{
  "thoughts": ["short reasoning"],
  "groups": [ { "name": "Category", "entries": [ { "i": <index>, "label": "friendly short label" } ] } ],
  "macros": [ { "name": "snake_id", "label": "friendly label", "group": "Category",
               "params": ["p1"], "steps": [ { "i": <index>, "assign": "var", "args": ["p1 | 'literal' | prior var"] } ], "result": "var" } ]
}

Rules:
- "i" MUST be an integer index shown in the list. Do not invent.
- Select operations relevant to the PURPOSE. Put the ${limit} MOST ESSENTIAL ones FIRST (they become the always-visible "core"); you MAY list up to ${limit * 2} more useful-but-secondary ones after those — they go under a collapsed "더 보기 / more" shelf, so nothing essential is lost to a hard cut. Order matters: most important first.
- Group into 2-5 intuitive categories. Write labels in the SAME LANGUAGE as the purpose, as SHORT task-oriented phrases (≤3 words, a verb + object like "포트 열기" / "open port" — never a full signature).
- Macros chain 2-4 real calls into one task; a step's args count must fit that call's parameters; later steps may use earlier "assign" vars.${lvl === 'beginner' ? '\n- BEGINNER: prefer MACROS — most of the core view should be whole-task macros (one block = one goal), with only a few primitives.' : ''}`;
  const userContent = `Library module: ${spec.module}\nPurpose: ${String(purpose).trim()}\nLevel: ${lvl}\n\nREAL API (reference by index "i"):\n${apiText}`;

  // technique D: retry once if the model returns unparseable JSON.
  async function askOnce(extra) {
    const { thinkingText, responseText } = await callMiniMax(systemPrompt + (extra || ''), userContent, { maxTokens: 2600 });
    const jsonStr = responseText.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    return { parsed: JSON.parse(jsonStr), thinkingText };
  }

  try {
    let parsed, thinkingText;
    try { ({ parsed, thinkingText } = await askOnce('')); }
    catch { ({ parsed, thinkingText } = await askOnce('\n\nYour previous reply was not valid JSON. Return ONLY the JSON object, nothing else.')); }

    const idxOk = (i) => Number.isInteger(i) && i >= 0 && i < entries.length;
    // groups -> selected[] (map index -> real ref); drop out-of-range indices.
    const selected = [];
    let droppedSel = 0;
    for (const g of parsed.groups || []) {
      for (const en of (g && g.entries) || []) {
        const i = en && en.i;
        if (idxOk(i)) selected.push({ ref: refOf(entries[i]), label: (en.label || ''), group: (g.name || '') });
        else droppedSel++;
      }
    }
    // macros: every step index valid AND its arg count fits the real signature (technique C: deterministic
    // arity verification) — otherwise drop the whole macro so no wrong-arity workflow is emitted.
    const macros = [];
    let droppedMac = 0;
    for (const m of parsed.macros || []) {
      const steps = Array.isArray(m && m.steps) ? m.steps : [];
      const ok = m && m.name && steps.length && steps.every((s) => {
        if (!s || !idxOk(s.i)) return false;
        const a = entryArity(entries[s.i]);
        const callArgs = a.isMethod ? Math.max(0, (Array.isArray(s.args) ? s.args.length : 0) - 1) : (Array.isArray(s.args) ? s.args.length : 0);
        return callArgs >= a.required && (a.vararg || callArgs <= a.total);
      });
      if (!ok) { droppedMac++; continue; }
      macros.push({
        name: String(m.name), label: m.label || m.name, group: m.group || '',
        params: Array.isArray(m.params) ? m.params.map(String) : [],
        steps: steps.map((s) => ({ ref: refOf(entries[s.i]), assign: s.assign ? String(s.assign) : '', args: Array.isArray(s.args) ? s.args.map(String) : [] })),
        result: m.result ? String(m.result) : '',
      });
    }
    const thoughts = [
      ...(thinkingText ? thinkingText.split('\n').filter((l) => l.trim()).slice(0, 3) : []),
      ...(parsed.thoughts || []),
    ].slice(0, 8);

    // Two-tier progressive disclosure (technique: MakeCode advanced=true / Resnick wide-walls):
    // instead of SLICING the tail away, keep it and TAG it. The first `limit` (by the model's rank)
    // are "core" (always visible); the rest up to a ceiling are "more" (a collapsed "더 보기" shelf in
    // the same tab). Nothing essential is silently dropped — the beginner view stays small but the
    // needed-but-9th op is one click away, not gone.
    const MORE_CEIL = Math.min(limit * 3, 40);
    const kept = selected.slice(0, MORE_CEIL);
    const tiered = kept.map((s, idx) => ({ ...s, tier: idx < limit ? 'core' : 'more' }));
    // Macro budget by level: beginner FAVORS macros (one block = one whole task), advanced prefers
    // primitives so learners compose. Macros still count toward keeping the smallest view sane.
    const macroLimit = lvl === 'beginner' ? Math.max(4, limit)
      : lvl === 'advanced' ? Math.min(3, macros.length)
        : Math.max(2, Math.floor(limit / 2));
    const cappedMacros = macros.slice(0, macroLimit);

    res.json({ success: true, module: spec.module, level: lvl, selected: tiered, macros: cappedMacros, thoughts, dropped: { selected: droppedSel + (selected.length - kept.length), macros: droppedMac + (macros.length - cappedMacros.length) } });
  } catch (err) {
    console.error('[/api/abstract-library]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── 4. AI Chat: general-purpose MiniMax chat for the AI Agent panel ──────────
app.post('/api/ai-chat', async (req, res) => {
  const { messages, systemPrompt } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (MINIMAX_KEYS.length === 0) {
    return res.status(503).json({ error: 'No MiniMax API keys configured.' });
  }

  try {
    const client = createMiniMaxClient();
    const response = await client.messages.create({
      model: MINIMAX_MODEL,
      max_tokens: 3000,
      system: systemPrompt || 'You are BlockPy AI – a helpful coding assistant for the BlockPy visual Python playground. When asked to write code, output only clean Python that can be visually represented as blocks.',
      messages
    });

    let thinking = '';
    let text = '';
    for (const block of response.content) {
      if (block.type === 'thinking') thinking += block.thinking;
      else if (block.type === 'text') text += block.text;
    }

    res.json({ success: true, thinking, text, model: MINIMAX_MODEL });
  } catch (err) {
    console.error('[/api/ai-chat] MiniMax error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
// ── Real Python execution in a local shell ──────────────────────────────────────
// Runs the user's code with the machine's actual Python (real cv2, real webcam, real
// imshow windows on the user's desktop). Streams stdout/stderr back live; aborting the
// request (Stop) kills the process. Intended for local single-user use.

app.post('/api/run-python', (req, res) => {
  const code = (req.body && req.body.code) || '';
  if (!code.trim()) { res.status(400).json({ error: 'No code provided' }); return; }

  const file = path.join(os.tmpdir(), `blockpy_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
  try { fs.writeFileSync(file, code, 'utf8'); }
  catch (e) { res.status(500).json({ error: 'Failed to write temp file: ' + e.message }); return; }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering for live streaming

  let child;
  try {
    child = spawn(PYTHON_CMD, ['-u', file], {
      cwd: MEDIA_DIR, // so cv2.imread('name.jpg') finds uploaded/sample images
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        PYTHONPATH: [RUNTIME_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
    });
  } catch (e) {
    res.write(`[shell error] could not start "${PYTHON_CMD}": ${e.message}\n`);
    try { fs.unlinkSync(file); } catch (_) {}
    res.end();
    return;
  }

  let done = false;
  const cleanup = () => { try { fs.unlinkSync(file); } catch (_) {} };

  child.stdout.on('data', (d) => res.write(d));
  child.stderr.on('data', (d) => res.write(d));
  child.on('error', (e) => {
    res.write(`\n[shell error] ${e.message}\n`);
    if (e.code === 'ENOENT') {
      res.write(`[shell] Python not found. Install Python (and opencv-python) or set PYTHON_CMD.\n`);
    }
  });
  child.on('close', (codeNum) => {
    done = true;
    res.write(`\n[exit ${codeNum}]\n`);
    cleanup();
    res.end();
  });

  // Browser aborted (Stop) → kill the Python process. Only kill on a genuine client
  // disconnect: res 'close' BEFORE the response finished normally (res.end not called).
  // Guarding on res.writableEnded avoids killing on normal completion or proxy quirks.
  res.on('close', () => {
    cleanup();
    if (!done && !res.writableEnded && child && !child.killed) {
      try { child.kill(); } catch (_) {}
    }
  });
});

// Real `pip install <package>` on the local machine (python -m pip). Streams output;
// installed packages become available to subsequent shell runs. spawn (no shell) +
// charset validation prevents command injection.
app.post('/api/pip-install', (req, res) => {
  const pkg = ((req.body && req.body.package) || '').trim();
  if (!pkg) { res.status(400).json({ error: 'package required' }); return; }
  if (!/^[A-Za-z0-9._\-=<>!\[\],~+ ]+$/.test(pkg)) {
    res.status(400).json({ error: 'invalid package spec' }); return;
  }
  // Reject pip FLAGS (whitespace-split tokens starting with '-') — a bare charset check still lets
  // "pkg --target=… --pre" through, redirecting where/what pip installs. Only package specs allowed.
  if (pkg.split(/\s+/).some((t) => t.startsWith('-'))) {
    res.status(400).json({ error: 'flags are not allowed in the package spec' }); return;
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  // Split on whitespace so "numpy pillow" or "pkg==1.2" both work; each token is a
  // separate arg (no shell interpolation).
  const args = ['-m', 'pip', 'install', ...pkg.split(/\s+/).filter(Boolean)];
  let child;
  try {
    child = spawn(PYTHON_CMD, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  } catch (e) {
    res.write(`[pip error] ${e.message}\n`); res.end(); return;
  }
  let done = false;
  child.stdout.on('data', (d) => res.write(d));
  child.stderr.on('data', (d) => res.write(d));
  child.on('error', (e) => res.write(`\n[pip error] ${e.message}\n`));
  child.on('close', (codeNum) => { done = true; res.write(`\n[pip exit ${codeNum}]\n`); res.end(); });
  res.on('close', () => { if (!done && !res.writableEnded && child && !child.killed) { try { child.kill(); } catch (_) {} } });
});

// ─── Robot (Dobot) bridge: DobotLink-mediated arm/car via dobotkit ─────────────
// Each call spawns scripts/robot_bridge.py with a JSON command on stdin; the script does ONE
// dobotkit action against DobotLink (ws://localhost:9090) and prints a JSON result. Stateless per
// call (DobotLink holds the hardware). Requires DobotLink.exe running + dobotkit installed in
// PYTHON_CMD; both failures surface as {ok:false,error,hint} (HTTP 200 so the UI can show them).
// genBase(): in the packaged app the script is asarUnpack'd — external python can't read app.asar.
const ROBOT_BRIDGE = path.join(genBase(), 'scripts', 'robot_bridge.py');
function runRobotBridge(command, res, timeoutMs) {
  let child;
  try {
    child = spawn(PYTHON_CMD, [ROBOT_BRIDGE], { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  } catch (e) {
    return res.json({ ok: false, error: `python 실행 실패: ${e.message}`, hint: 'PYTHON_CMD 확인' });
  }
  // Settle-once guard (as in /api/infer-types): 'error'/'close'/timeout race — exactly one reply.
  let responded = false;
  let timer = null;
  const reply = (body) => {
    if (responded) return;
    responded = true;
    clearTimeout(timer);
    res.json(body);
  };
  timer = setTimeout(() => {
    killTree(child);
    reply({ ok: false, error: `로봇 브리지 시간초과(${timeoutMs}ms)`, hint: 'DobotLink 응답 없음 — DobotLink.exe/로봇 상태를 확인하세요.' });
  }, timeoutMs);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => {}); // drain — an undrained pipe can deadlock the child
  child.on('error', (e) => reply({ ok: false, error: `python 실행 오류: ${e.message}`, hint: 'PYTHON_CMD 확인' }));
  child.on('close', () => { try { reply(JSON.parse(out.trim().split('\n').pop() || '')); } catch (_) { reply({ ok: false, error: '로봇 브리지 응답 파싱 실패', hint: (out || '').slice(0, 400) }); } });
  try { child.stdin.write(JSON.stringify(command)); child.stdin.end(); } catch (_) { /* child died — 'close'/'error' handles it */ }
}

app.post('/api/robot/ports', (req, res) => {
  const device = (req.body && req.body.device) === 'go' ? 'go' : 'lite';
  runRobotBridge({ action: 'ports', device }, res, 15000);
});
app.post('/api/robot/connect', (req, res) => {
  const b = req.body || {};
  runRobotBridge({ action: 'connect', device: b.device === 'go' ? 'go' : 'lite', port: b.port || 'auto' }, res, 25000);
});
app.post('/api/robot/disconnect', (req, res) => {
  const b = req.body || {};
  runRobotBridge({ action: 'disconnect', device: b.device === 'go' ? 'go' : 'lite', port: b.port || 'auto' }, res, 15000);
});
app.post('/api/robot/move-preset', (req, res) => {
  const b = req.body || {};
  if (typeof b.x !== 'number' || typeof b.y !== 'number') return res.status(400).json({ ok: false, error: 'x, y (number) 필요' });
  // Motion (optional home + move, wait-for-finish) can take a while. This MUST exceed the bridge's
  // own sequential RPC deadlines (connect+queue+home+move+pose ≈ up to ~110s) so a slow-but-legit
  // home surfaces as a clean {ok:false} DobotTimeoutError from dobotkit instead of the server
  // killTree-ing python mid-motion (which would leave the queued move running while the UI shows a
  // false timeout). 120s > that sum.
  runRobotBridge({ action: 'move_preset', device: 'lite', port: b.port || 'auto', x: b.x, y: b.y, z: (typeof b.z === 'number' ? b.z : undefined), home: !!b.home }, res, 120000);
});

// ─── 안전 정지 (계약 3) ────────────────────────────────────────────────────────
// 왜 필요한가: 학생이 [정지] 를 눌러 파이썬을 죽여도 **에어펌프(진공)는 계속 돌아간다**.
// 프로그램이 죽는 것과 하드웨어가 멈추는 것은 다른 일이다 — 펌프가 켜진 채 남으면 소음이
// 계속되고 물건이 붙어 있어 다음 수업이 시작되지 못한다. 그래서 정지 버튼은 실행 중단 뒤
// 이 API 를 **항상** 호출한다. 로봇이 없거나 DobotLink 가 꺼져 있는 교실이 태반이므로
// 실패는 오류(500)가 아니라 200 + {ok:false, reason} 이다 — 절대 서버를 죽이지 않는다.
const ROBOT_SAFE_STOP_PY = [
  '# -*- coding: utf-8 -*-',
  '# Generated by BlockPy /api/robot/safe-stop. 펌프(+그리퍼)를 끄고 끝낸다.',
  'import json, sys',
  '',
  'def emit(obj):',
  '    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")',
  '    sys.stdout.flush()',
  '',
  'try:',
  '    import dobotkit',
  'except Exception as e:',
  '    emit({"ok": False, "reason": "dobotkit 가 설치되어 있지 않습니다 (%s)" % e,',
  '          "hint": "pip install dobotkit"})',
  '    sys.exit(0)',
  '',
  'try:',
  '    arm = dobotkit.MagicianLite()',
  'except Exception as e:',
  '    emit({"ok": False, "reason": "로봇에 연결하지 못했습니다 (%s)" % e,',
  '          "hint": "DobotLink.exe 실행과 로봇 전원을 확인하세요."})',
  '    sys.exit(0)',
  '',
  'done = []',
  'try:',
  '    arm.pump_off()',
  '    done.append("pump_off")',
  'except Exception as e:',
  '    emit({"ok": False, "reason": "펌프를 끄지 못했습니다 (%s)" % e,',
  '          "hint": "컨트롤러 알람이면 로봇 전원을 껐다 켜야 합니다."})',
  '    sys.exit(0)',
  '',
  '# 그리퍼는 장착돼 있지 않을 수 있다 — 실패해도 펌프는 이미 껐으므로 성공으로 본다.',
  'try:',
  '    arm.grip(False)',
  '    done.append("grip_off")',
  'except Exception:',
  '    pass',
  '',
  'emit({"ok": True, "done": done, "message": "로봇의 바람(펌프)을 껐습니다."})',
  ''
].join('\n');

const ROBOT_SAFE_STOP_TIMEOUT_MS = 20000; // 계약 3: 20초

app.post('/api/robot/safe-stop', (req, res) => {
  runPythonSnippet(ROBOT_SAFE_STOP_PY, { timeoutMs: ROBOT_SAFE_STOP_TIMEOUT_MS }, (r) => {
    if (r.timedOut) {
      return res.json({ ok: false, reason: `안전 정지 시간초과(${ROBOT_SAFE_STOP_TIMEOUT_MS / 1000}초)`,
        hint: 'DobotLink 가 응답하지 않습니다. DobotLink.exe/로봇 상태를 확인하세요.' });
    }
    if (!r.ok) return res.json({ ok: false, reason: r.error, hint: 'PYTHON_CMD 확인' });
    const parsed = lastJsonLine(r.stdout);
    if (!parsed) {
      return res.json({ ok: false, reason: '안전 정지 응답을 읽지 못했습니다.',
        hint: (r.stderr || r.stdout || '').slice(-400) });
    }
    res.json(parsed);
  });
});

// ─── 캘리브레이션 내보내기 (계약 4) ─────────────────────────────────────────────
// 왜 필요한가: 카메라 픽셀 → 로봇 좌표 변환값(M)이 브라우저 localStorage 에만 있으면
// **파이썬 쪽에서 쓸 수 없다**. runtime/robotvision.py 는 워크스페이스의 robot_calib.json 을
// 읽어 동작하므로, 보정할 때 이 API 로도 함께 내려 파일로 남긴다.
// 파일은 학생이 열어 볼 수 있게 들여쓰기 2 로 원자적으로 쓴다.
const ROBOT_CALIB_FILE = path.join(WORKSPACE_DIR, 'robot_calib.json');

app.post('/api/robot/calib', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: '보정 데이터(JSON 객체)가 필요합니다.' });
  }
  try {
    writeJsonAtomic(ROBOT_CALIB_FILE, body);
    res.json({ ok: true, path: 'robot_calib.json', absPath: ROBOT_CALIB_FILE });
  } catch (e) {
    // 저장 실패가 앱을 멈추게 하면 안 된다 — 이유만 알려 주고 계속 쓰게 둔다.
    res.json({ ok: false, error: '보정 파일을 저장하지 못했습니다: ' + e.message });
  }
});

app.get('/api/robot/calib', (req, res) => {
  try {
    if (!fs.existsSync(ROBOT_CALIB_FILE)) return res.json({ measured: false });
    const parsed = JSON.parse(fs.readFileSync(ROBOT_CALIB_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return res.json({ measured: false });
    res.json(parsed);
  } catch (e) {
    // 파일이 깨져 있어도 200 — 프런트는 "아직 보정 안 됨" 으로 취급하면 된다.
    res.json({ measured: false, error: '보정 파일을 읽지 못했습니다: ' + e.message });
  }
});

// ─── 카메라 목록 (계약 2) ──────────────────────────────────────────────────────
// 왜 필요한가: 교실 PC 마다 웹캠 인덱스가 다르다(내장 0, 외장 1, 가상캠 2…). 학생에게
// "숫자를 바꿔 가며 찍어 보라" 고 시킬 수 없으므로 서버가 **실제로 열리는 인덱스만** 알려 준다.
// 반드시 release() 로 닫는다 — 열어 둔 채 두면 그 뒤 학생 프로그램이 카메라를 못 연다.
// 실패해도 500 이 아니라 200 + available:[] (계약).
const CAMERA_PROBE_PY = [
  '# -*- coding: utf-8 -*-',
  '# Generated by BlockPy /api/cameras. 0~3 을 열어 보고 열리는 것만 보고한 뒤 반드시 닫는다.',
  'import json, os, sys',
  'os.environ.setdefault("OPENCV_LOG_LEVEL", "SILENT")   # 없는 인덱스마다 나오는 경고 잡음 제거',
  'os.environ.setdefault("OPENCV_VIDEOIO_PRIORITY_MSMF", "0")',
  '',
  'def emit(obj):',
  '    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")',
  '    sys.stdout.flush()',
  '',
  'try:',
  '    import cv2',
  'except Exception as e:',
  '    emit({"available": [], "checked": [], "error": "opencv-python(cv2) 를 불러오지 못했습니다: %s" % e})',
  '    sys.exit(0)',
  '',
  'INDEXES = [0, 1, 2, 3]',
  'available, checked = [], []',
  'for i in INDEXES:',
  '    checked.append(i)',
  '    cap = None',
  '    try:',
  '        # win32 는 DSHOW 가 훨씬 빠르고 조용하다(MSMF 는 없는 장치에서 수 초씩 멈춘다).',
  '        if sys.platform == "win32":',
  '            cap = cv2.VideoCapture(i, cv2.CAP_DSHOW)',
  '        else:',
  '            cap = cv2.VideoCapture(i)',
  '        if cap is not None and cap.isOpened():',
  '            available.append(i)',
  '    except Exception:',
  '        pass',
  '    finally:',
  '        # 여기서 못 닫으면 학생 프로그램이 카메라를 못 연다. 무슨 일이 있어도 닫는다.',
  '        try:',
  '            if cap is not None:',
  '                cap.release()',
  '        except Exception:',
  '            pass',
  'try:',
  '    cv2.destroyAllWindows()',
  'except Exception:',
  '    pass',
  'emit({"available": available, "checked": checked})',
  ''
].join('\n');

const CAMERA_PROBE_TIMEOUT_MS = 15000; // 계약 2: 15초
const CAMERA_NOTE = 'TM 패널이 웹캠을 쓰고 있으면 목록이 비거나 줄 수 있다';

app.get('/api/cameras', (req, res) => {
  runPythonSnippet(CAMERA_PROBE_PY, { timeoutMs: CAMERA_PROBE_TIMEOUT_MS }, (r) => {
    if (r.timedOut) {
      return res.json({ available: [], checked: [0, 1, 2, 3], note: CAMERA_NOTE,
        error: `카메라 확인 시간초과(${CAMERA_PROBE_TIMEOUT_MS / 1000}초)` });
    }
    if (!r.ok) return res.json({ available: [], checked: [], note: CAMERA_NOTE, error: r.error });
    const parsed = lastJsonLine(r.stdout);
    if (!parsed || !Array.isArray(parsed.available)) {
      return res.json({ available: [], checked: [], note: CAMERA_NOTE,
        error: '카메라 확인 응답을 읽지 못했습니다: ' + (r.stderr || r.stdout || '').slice(-300) });
    }
    res.json({ available: parsed.available, checked: parsed.checked || [0, 1, 2, 3], note: CAMERA_NOTE,
      ...(parsed.error ? { error: parsed.error } : {}) });
  });
});

// Save an uploaded image to the media dir so shell-run Python can cv2.imread() it.
app.post('/api/upload-image', (req, res) => {
  const { filename, dataBase64 } = req.body || {};
  if (!filename || !dataBase64) { res.status(400).json({ error: 'filename and dataBase64 required' }); return; }
  // sanitize filename to a basename (no path traversal)
  const safe = path.basename(String(filename)).replace(/[^\w.\-]/g, '_') || 'upload.png';
  try {
    const bytes = Buffer.from(String(dataBase64).replace(/^data:[^,]+,/, ''), 'base64');
    fs.writeFileSync(path.join(MEDIA_DIR, safe), bytes);
    res.json({ ok: true, savedAs: safe, dir: MEDIA_DIR });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save image: ' + e.message });
  }
});

// ─── Teachable Machine: train in PYTHON from browser-captured frames ───────────
// The TM panel is only the collection/preview UI. The model that students actually load from
// their code is produced HERE: the browser POSTs the raw JPEG frames it captured, we spill them
// to a temp dir and let runtime/tm.py (Keras MobileNetV2 + small head) do the featurizing,
// training and saving. Result is a python-native <name>.npz in the workspace, so example code can
// do tm.load_model('my-model.npz') directly. (Training in the browser instead would produce a
// TF.js-MobileNet embedding space that tm.py cannot reuse — different features, not just format.)
// Same local single-user trust model as /api/run-python; user-facing failures come back as
// HTTP 200 {ok:false,error,hint} so the panel can show them in Korean.
const TM_MAX_SAMPLES = 600;
const TM_TRAIN_TIMEOUT_MS = 300000; // TF import + MobileNet embed of every frame + fit: slow.
const TM_TRAIN_PY = [
  '# -*- coding: utf-8 -*-',
  '# Generated by BlockPy /api/tm/train. Reads a manifest (frame paths + labels), trains via tm.py.',
  'import json, sys',
  '',
  'def emit(obj):',
  '    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")',
  '    sys.stdout.flush()',
  '',
  'try:',
  '    import cv2',
  '    import tm',
  'except Exception as e:',
  '    emit({"ok": False, "error": "TM 학습 준비 실패: %s" % e,',
  '          "hint": "python 에 tensorflow / opencv-python / numpy 가 설치되어 있어야 합니다."})',
  '    sys.exit(0)',
  '',
  'try:',
  '    man = json.load(open(sys.argv[1], "r", encoding="utf-8"))',
  '    labels = [str(x) for x in man["labels"]]',
  '    out_path = man["out"]',
  '    epochs = int(man.get("epochs") or 30)',
  '    model = tm.Model(labels)',
  '    used, skipped = 0, 0',
  '    for item in man["samples"]:',
  '        img = cv2.imread(item["path"])',
  '        if img is None:',
  '            skipped += 1',
  '            sys.stderr.write("[tm] unreadable frame skipped: %s\\n" % item["path"])',
  '            continue',
  '        model.add_example(img, item["label"])',
  '        used += 1',
  '    if used == 0:',
  '        emit({"ok": False, "error": "읽을 수 있는 샘플 이미지가 없습니다.",',
  '              "hint": "카메라 프레임이 비어 있었을 수 있습니다. 다시 수집해 주세요."})',
  '        sys.exit(0)',
  '    sys.stderr.write("[tm] training on %d frames, %d epochs\\n" % (used, epochs))',
  '    model.train(epochs=epochs)',
  '    model.save(out_path)',
  '    emit({"ok": True, "path": out_path, "samples": used, "skipped": skipped, "labels": labels})',
  'except Exception as e:',
  '    emit({"ok": False, "error": "TM 학습 실패: %s" % e})',
  '    sys.exit(0)',
  ''
].join('\n');

// ─── tensorflow 자동 설치 (계약 5) ──────────────────────────────────────────────
// 왜 필요한가: TM 학습은 tensorflow 가 있어야 돌아가는데, 교실 PC 에 그것이 깔려 있는지
// 학생이 알 수도, 직접 설치할 수도 없다("pip install 하세요" 는 수업을 멈추게 한다).
// 그래서 학습이 시작될 때 서버가 대신 확인하고 없으면 깔아 준다.
// 설치는 수백 MB — 몇 분 걸린다. /api/tm/train 은 (스트리밍이 아니라) JSON 하나를 돌려주는
// 엔드포인트라 응답 중간에 알릴 채널이 없으므로, 시작하자마자
//   1) 서버 콘솔에 안내 문구를 찍고
//   2) GET /api/tm/prepare-status 로 진행 상황(설치 로그)을 폴링할 수 있게 열어 둔다.
// 마지막 학습 응답에도 notice 로 같은 문구를 실어 보낸다.
const TF_NOTICE = 'AI 학습 준비물을 내려받는 중입니다. 몇 분 걸립니다';
const TF_CHECK_TIMEOUT_MS = 60000;
const TF_INSTALL_TIMEOUT_MS = 30 * 60 * 1000; // 느린 회선에서도 끝나게 넉넉히
// 확인은 `import tensorflow` 대신 find_spec 으로 한다 — 실제 import 는 (설치돼 있어도)
// 20~60초씩 걸려 매번 학습 시작을 그만큼 늦춘다. 설치 여부 판정에는 find_spec 이면 충분하다.
const TF_CHECK_PY = [
  '# -*- coding: utf-8 -*-',
  '# Generated by BlockPy /api/tm/train. tensorflow 설치 여부만 빠르게 확인한다.',
  'import json, sys, importlib.util',
  'found = False',
  'try:',
  '    found = importlib.util.find_spec("tensorflow") is not None',
  'except Exception:',
  '    found = False',
  'sys.stdout.write(json.dumps({"tensorflow": bool(found)}) + "\\n")',
  ''
].join('\n');

let tmPrepare = { status: 'idle', message: '', log: [], startedAt: null, endedAt: null };
let tfEnsurePromise = null;

function tmPrepLog(line) {
  const s = String(line == null ? '' : line).replace(/\r/g, '').trimEnd();
  if (!s) return;
  tmPrepare.log.push(s);
  if (tmPrepare.log.length > 400) tmPrepare.log.splice(0, tmPrepare.log.length - 400);
  console.log('[tm-prep]', s);
}

// python -m pip install <pkg> 를 돌리며 줄 단위로 진행 상황을 tmPrepare.log 에 남긴다.
// 반드시 타임아웃 + killTree (좀비 pip 금지). done 은 한 번만 호출된다.
function pipInstallStreaming(pkg, timeoutMs, done) {
  let child;
  try {
    child = spawn(PYTHON_CMD, ['-u', '-m', 'pip', 'install', '--progress-bar', 'off', pkg], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
    });
  } catch (e) {
    done({ ok: false, error: `pip 실행 실패: ${e.message}` });
    return;
  }
  let settled = false;
  let tail = '';
  let timer = null;
  const settle = (r) => { if (settled) return; settled = true; clearTimeout(timer); done(r); };
  timer = setTimeout(() => {
    killTree(child);
    settle({ ok: false, error: `설치 시간초과(${Math.round(timeoutMs / 60000)}분) — 인터넷 연결을 확인하세요.`, tail });
  }, timeoutMs);
  if (timer.unref) timer.unref();
  const onData = (d) => {
    const s = d.toString();
    tail = (tail + s).slice(-4000);
    s.split('\n').forEach(tmPrepLog);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => settle({ ok: false, error: `pip 실행 오류: ${e.message}`, tail }));
  child.on('close', (codeNum) => settle(codeNum === 0
    ? { ok: true }
    : { ok: false, error: `설치에 실패했습니다(pip 종료 코드 ${codeNum}).`, tail }));
}

// tensorflow 를 보장한다. 이미 있으면 즉시 통과, 없으면 설치. 동시에 여러 요청이 와도
// 설치는 한 번만 돈다(같은 Promise 를 공유). 실패하면 캐시를 비워 다음 시도가 가능하게 한다.
function ensureTensorflow() {
  if (tfEnsurePromise) return tfEnsurePromise;
  tfEnsurePromise = new Promise((resolve) => {
    tmPrepare = { status: 'checking', message: 'AI 학습 준비물을 확인하는 중입니다…', log: [], startedAt: Date.now(), endedAt: null };
    runPythonSnippet(TF_CHECK_PY, { timeoutMs: TF_CHECK_TIMEOUT_MS }, (r) => {
      const parsed = r.ok ? lastJsonLine(r.stdout) : null;
      if (parsed && parsed.tensorflow === true) {
        tmPrepare = { ...tmPrepare, status: 'ready', message: 'AI 학습 준비물이 이미 설치되어 있습니다.', endedAt: Date.now() };
        return resolve({ ok: true, installed: false });
      }
      if (!parsed) {
        // 확인 자체가 안 됐다(파이썬이 없거나 시간초과). 설치를 시도할 상황이 아니다.
        tmPrepare = { ...tmPrepare, status: 'failed', message: '파이썬을 확인하지 못했습니다.', endedAt: Date.now() };
        tfEnsurePromise = null;
        return resolve({ ok: false,
          error: 'AI 학습 준비물을 확인하지 못했습니다: ' + (r.error || (r.stderr || '').slice(-200) || '알 수 없는 오류'),
          hint: 'PYTHON_CMD 로 지정한 파이썬이 실행되는지 확인하세요.' });
      }
      // ── 없다 → 설치. 사용자에게 **먼저** 알린다(계약 5). ──
      tmPrepare = { status: 'installing', message: TF_NOTICE, log: [], startedAt: Date.now(), endedAt: null };
      tmPrepLog(TF_NOTICE);
      pipInstallStreaming('tensorflow', TF_INSTALL_TIMEOUT_MS, (ins) => {
        if (ins.ok) {
          tmPrepare = { ...tmPrepare, status: 'ready', message: 'AI 학습 준비물 내려받기가 끝났습니다.', endedAt: Date.now() };
          tmPrepLog('AI 학습 준비물 내려받기가 끝났습니다.');
          return resolve({ ok: true, installed: true, notice: TF_NOTICE });
        }
        tmPrepare = { ...tmPrepare, status: 'failed', message: ins.error, endedAt: Date.now() };
        tmPrepLog(ins.error);
        tfEnsurePromise = null; // 다시 시도할 수 있게
        resolve({ ok: false,
          error: 'AI 학습 준비물(tensorflow)을 설치하지 못했습니다: ' + ins.error,
          hint: '인터넷 연결을 확인하거나, 터미널에서 `python -m pip install tensorflow` 를 직접 실행해 보세요. ' + String(ins.tail || '').slice(-300) });
      });
    });
  });
  return tfEnsurePromise;
}

// TM 학습 준비(= tensorflow 내려받기) 진행 상황. 학습 응답이 JSON 하나뿐이라 그동안 화면이
// 멈춘 것처럼 보인다 — 패널이 이 엔드포인트를 폴링해 "몇 분 걸립니다" 를 보여 줄 수 있다.
app.get('/api/tm/prepare-status', (req, res) => {
  res.json({
    status: tmPrepare.status,          // idle | checking | installing | ready | failed
    installing: tmPrepare.status === 'installing',
    message: tmPrepare.message || '',
    log: tmPrepare.log.slice(-60),
    startedAt: tmPrepare.startedAt,
    endedAt: tmPrepare.endedAt,
  });
});

// /api/tm/train 앞에 끼우는 관문(미들웨어): 학습을 시작하기 전에 tensorflow 를 보장한다.
// 미들웨어로 둔 이유 — 기존 학습 핸들러(검증·프레임 저장·타임아웃/killTree)를 한 줄도
// 건드리지 않고 준비 단계만 앞에 붙일 수 있기 때문이다.
function tmEnsureTfMiddleware(req, res, next) {
  // 애초에 학습이 불가능한 요청(클래스/샘플 부족)이면 설치하지 말고 그대로 통과시켜
  // 본래의 한국어 안내가 나가게 한다 — 수백 MB 를 헛되이 받지 않도록.
  const b = req.body || {};
  const labelCount = Array.isArray(b.labels)
    ? b.labels.map((l) => String(l == null ? '' : l).trim()).filter(Boolean).length : 0;
  if (labelCount < 2 || !Array.isArray(b.samples) || b.samples.length === 0) return next();

  // 브라우저가 이미 떠났는지 판단은 **응답(res)** 으로만 한다. req.destroyed 는 쓰면 안 된다 —
  // express.json 이 본문을 다 읽고 나면 정상 요청에서도 참이라 학습이 통째로 멈춰 버린다(실측).
  const gone = () => res.writableEnded || res.destroyed;
  ensureTensorflow().then((prep) => {
    if (gone()) return;
    if (!prep.ok) return res.json({ ok: false, error: prep.error, hint: prep.hint });
    if (prep.notice) res.locals.tmNotice = prep.notice;
    next();
  }).catch((e) => {
    if (gone()) return;
    res.json({ ok: false, error: 'AI 학습 준비 중 오류: ' + (e && e.message), hint: 'PYTHON_CMD 확인' });
  });
}

app.post('/api/tm/train', tmEnsureTfMiddleware, (req, res) => {
  const body = req.body || {};
  const fail = (error, hint) => res.json({ ok: false, error, hint });

  // ── validate labels / samples ──
  const labels = (Array.isArray(body.labels) ? body.labels : [])
    .map((l) => String(l == null ? '' : l).trim()).filter(Boolean);
  if (labels.length < 2) {
    return fail('클래스가 2개 이상이어야 학습할 수 있습니다.', '클래스를 추가하고 이름을 정해 주세요.');
  }
  if (new Set(labels).size !== labels.length) {
    return fail('클래스 이름이 중복됩니다.', '각 클래스에 서로 다른 이름을 지어 주세요.');
  }
  const samples = Array.isArray(body.samples) ? body.samples : [];
  if (samples.length === 0) {
    return fail('수집된 샘플이 없습니다.', '각 클래스에서 "누르는 동안 수집" 으로 사진을 모아 주세요.');
  }
  if (samples.length > TM_MAX_SAMPLES) {
    return fail(`샘플이 너무 많습니다(${samples.length}장). 최대 ${TM_MAX_SAMPLES}장까지 학습할 수 있습니다.`,
      '클래스별 샘플 수를 줄이고 다시 시도하세요.');
  }
  const counts = new Map(labels.map((l) => [l, 0]));
  for (const s of samples) {
    const l = String((s && s.label) == null ? '' : s.label).trim();
    if (counts.has(l)) counts.set(l, counts.get(l) + 1);
  }
  const emptyLabels = labels.filter((l) => counts.get(l) === 0);
  if (emptyLabels.length) {
    return fail(`샘플이 없는 클래스가 있습니다: ${emptyLabels.join(', ')}`,
      '각 클래스마다 최소 1장 이상 수집해야 합니다.');
  }

  // ── validate destination: always <workspace>/<name>.npz, never outside ──
  const cleanedName = String(body.filename == null ? '' : body.filename).trim().replace(/\.(npz|json)$/i, '');
  if (!cleanedName) return fail('모델 파일 이름을 입력하세요.', '예: my-model');
  const outAbs = safeResolve(cleanedName + '.npz');
  if (!outAbs || path.basename(outAbs) === '.npz') {
    return fail('모델 파일 이름이 올바르지 않습니다.', '워크스페이스 밖 경로(.. 등)는 쓸 수 없습니다.');
  }
  const outRel = path.relative(WORKSPACE_DIR, outAbs).replace(/\\/g, '/');
  const epochs = Math.min(200, Math.max(1, Math.floor(Number(body.epochs) || 30)));

  // ── spill frames to a temp dir ──
  let tmpDir;
  try { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockpy_tm_')); }
  catch (e) { return fail('임시 폴더를 만들 수 없습니다: ' + e.message); }
  const cleanupTmp = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };

  const manifest = { labels, out: outAbs, epochs, samples: [] };
  try {
    samples.forEach((s, i) => {
      const label = String((s && s.label) == null ? '' : s.label).trim();
      if (!counts.has(label)) return; // label not in labels[] — ignore
      const b64 = String((s && s.jpegBase64) || '').replace(/^data:[^,]+,/, '');
      if (!b64) return;
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) return;
      const p = path.join(tmpDir, `frame_${i}.jpg`);
      fs.writeFileSync(p, buf);
      manifest.samples.push({ path: p, label });
    });
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'train_tm.py'), TM_TRAIN_PY, 'utf8');
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  } catch (e) {
    cleanupTmp();
    return fail('샘플 이미지를 임시 저장하지 못했습니다: ' + e.message);
  }
  if (!manifest.samples.length) {
    cleanupTmp();
    return fail('저장 가능한 샘플 이미지가 없습니다.', '각 샘플에 jpegBase64 이미지 데이터가 필요합니다.');
  }

  let child;
  try {
    child = spawn(PYTHON_CMD, ['-u', path.join(tmpDir, 'train_tm.py'), path.join(tmpDir, 'manifest.json')], {
      cwd: WORKSPACE_DIR,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
        PYTHONPATH: [RUNTIME_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
    });
  } catch (e) {
    cleanupTmp();
    return fail(`python 실행 실패: ${e.message}`, 'PYTHON_CMD 확인');
  }

  // Settle-once guard (as in runRobotBridge): 'error'/'close'/timeout/abort race — exactly one
  // reply, and the temp dir is removed on every path.
  let responded = false;
  let timer = null;
  const reply = (payload) => {
    if (responded) return;
    responded = true;
    clearTimeout(timer);
    cleanupTmp();
    res.json(payload);
  };
  timer = setTimeout(() => {
    killTree(child);
    reply({ ok: false, error: `학습 시간초과(${Math.round(TM_TRAIN_TIMEOUT_MS / 1000)}초) — 샘플 수를 줄여 다시 시도해 보세요.`,
      hint: 'tensorflow 첫 로딩이 오래 걸릴 수 있습니다.' });
  }, TM_TRAIN_TIMEOUT_MS);

  let out = '';
  let errOut = '';
  child.stdout.on('data', (d) => { out += d; if (out.length > 200000) out = out.slice(-200000); });
  child.stderr.on('data', (d) => { errOut += d; if (errOut.length > 200000) errOut = errOut.slice(-200000); });
  child.on('error', (e) => reply({ ok: false, error: `python 실행 오류: ${e.message}`, hint: 'PYTHON_CMD 확인' }));
  child.on('close', () => {
    // The script prints exactly one JSON line; TF chatter goes to stderr. Scan bottom-up anyway.
    const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].startsWith('{')) continue;
      let parsed;
      try { parsed = JSON.parse(lines[i]); } catch (_) { continue; }
      if (!parsed || typeof parsed !== 'object') continue;
      // notice: 이번 요청에서 tensorflow 를 새로 내려받았다면 그 사실을 함께 알린다(계약 5).
      if (parsed.ok) return reply({ ...parsed, path: outRel, absPath: outAbs, ...(res.locals.tmNotice ? { notice: res.locals.tmNotice } : {}) });
      return reply({ ok: false, error: parsed.error || 'TM 학습 실패', hint: parsed.hint || errOut.slice(-400) });
    }
    reply({ ok: false, error: 'TM 학습 응답 파싱 실패', hint: (out || errOut || '').slice(-400) });
  });

  // Browser navigated away / aborted → don't leave python (and its TF) running.
  res.on('close', () => {
    if (responded) return;
    responded = true;
    clearTimeout(timer);
    killTree(child);
    cleanupTmp();
  });
});

// ─── Workspace file system API (the VS Code-style file explorer) ────────────────
// All paths are RELATIVE to WORKSPACE_DIR and validated by safeResolve (no traversal).
// Read-only static mount so the frontend can preview images: GET /workspace/<relpath>.
app.use('/workspace', express.static(WORKSPACE_DIR));

const TEXT_EXT = new Set(['.py','.txt','.md','.json','.csv','.html','.css','.js','.xml','.yml','.yaml','.ini','.cfg','.log','.tsv']);
const IMAGE_EXT = new Set(['.png','.jpg','.jpeg','.gif','.bmp','.webp','.svg']);

function buildTree(absDir, relDir, depth) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch (_) { return out; }
  // Folders first, then files; both alphabetical (case-insensitive).
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  for (const e of entries) {
    // .blockpy 는 앱이 쓰는 상태 폴더(state.json)다 — 학생 파일이 아니므로 탐색기에서 숨긴다.
    if (e.name === '.git' || e.name === '__pycache__' || e.name === '.blockpy') continue;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      out.push({ name: e.name, path: rel, type: 'dir', children: depth > 0 ? buildTree(abs, rel, depth - 1) : [] });
    } else {
      const ext = path.extname(e.name).toLowerCase();
      let size = 0; try { size = fs.statSync(abs).size; } catch (_) {}
      out.push({ name: e.name, path: rel, type: 'file', ext, size, kind: IMAGE_EXT.has(ext) ? 'image' : TEXT_EXT.has(ext) ? 'text' : 'binary' });
    }
  }
  return out;
}

app.get('/api/fs/root', (req, res) => {
  res.json({ root: WORKSPACE_DIR });
});

app.get('/api/fs/tree', (req, res) => {
  res.json({ root: WORKSPACE_DIR, tree: buildTree(WORKSPACE_DIR, '', 12) });
});

app.get('/api/fs/file', (req, res) => {
  const abs = safeResolve(req.query.path);
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: 'not found' });
  const ext = path.extname(abs).toLowerCase();
  if (IMAGE_EXT.has(ext)) {
    // Images are previewed via the /workspace static mount, not inlined here.
    return res.json({ path: req.query.path, kind: 'image', url: '/workspace/' + String(req.query.path).replace(/\\/g, '/') });
  }
  try {
    const content = fs.readFileSync(abs, 'utf8');
    res.json({ path: req.query.path, kind: 'text', content });
  } catch (e) {
    res.status(500).json({ error: 'read failed: ' + e.message });
  }
});

app.post('/api/fs/file', (req, res) => {
  const abs = safeResolve(req.body && req.body.path);
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String((req.body && req.body.content) || ''), 'utf8');
    res.json({ ok: true, path: req.body.path });
  } catch (e) {
    res.status(500).json({ error: 'write failed: ' + e.message });
  }
});

app.post('/api/fs/mkdir', (req, res) => {
  const abs = safeResolve(req.body && req.body.path);
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  try { fs.mkdirSync(abs, { recursive: true }); res.json({ ok: true, path: req.body.path }); }
  catch (e) { res.status(500).json({ error: 'mkdir failed: ' + e.message }); }
});

app.post('/api/fs/delete', (req, res) => {
  const abs = safeResolve(req.body && req.body.path);
  if (!abs) return res.status(400).json({ error: 'invalid path' });
  if (abs === path.resolve(WORKSPACE_DIR)) return res.status(400).json({ error: 'cannot delete the workspace root' });
  try { fs.rmSync(abs, { recursive: true, force: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'delete failed: ' + e.message }); }
});

app.post('/api/fs/rename', (req, res) => {
  const from = safeResolve(req.body && req.body.from);
  const to = safeResolve(req.body && req.body.to);
  if (!from || !to) return res.status(400).json({ error: 'invalid path' });
  try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); res.json({ ok: true, path: req.body.to }); }
  catch (e) { res.status(500).json({ error: 'rename failed: ' + e.message }); }
});

// ─── 앱 실시간 상태 파일 (계약 1) ───────────────────────────────────────────────
// 왜 필요한가: 터미널의 AI 도우미는 브라우저 화면을 볼 수 없다. 학생이 "왜 안 돼요?" 라고
// 물었을 때 도우미가 지금 어느 탭인지·무슨 파일인지·실행 중인지·마지막 출력이 무엇인지
// 알 수 있어야 답할 수 있다. 그래서 프런트가 보낸 상태를 워크스페이스의
// .blockpy/state.json 으로 떨궈 둔다(도우미가 그냥 파일로 읽는다).
// - 원자적 쓰기(임시파일 → rename): 반쯤 쓰인 JSON 을 도우미가 읽는 일이 없게.
// - 최대 1초에 한 번만 쓴다: 프런트는 상태가 바뀔 때마다 보내므로 그대로 쓰면 디스크를 혹사한다.
// - 마지막 값은 메모리에도 들고 있어 GET 이 항상 최신을 준다.
// - **어떤 실패도 앱을 죽이지 않는다** — 상태 파일은 부가 기능이지 본체가 아니다.
const UI_STATE_FILE = path.join(WORKSPACE_DIR, '.blockpy', 'state.json');
const UI_STATE_MIN_INTERVAL_MS = 1000;
let uiStateLatest = null;   // 마지막으로 받은 상태(아직 안 쓰였을 수도 있다)
let uiStateWrittenAt = 0;
let uiStateTimer = null;

function flushUiState() {
  uiStateTimer = null;
  if (uiStateLatest == null) return;
  uiStateWrittenAt = Date.now();
  try { writeJsonAtomic(UI_STATE_FILE, uiStateLatest); }   // 폴더가 없으면 만든다
  catch (e) { console.log('[ui-state] write skipped:', e && e.message); }
}

function scheduleUiStateWrite(state) {
  uiStateLatest = state;
  if (uiStateTimer) return; // 이미 예약돼 있다 — 그때 최신값이 한 번에 쓰인다(스로틀)
  const wait = UI_STATE_MIN_INTERVAL_MS - (Date.now() - uiStateWrittenAt);
  if (wait <= 0) { flushUiState(); return; }
  uiStateTimer = setTimeout(flushUiState, wait);
  if (uiStateTimer.unref) uiStateTimer.unref(); // 남은 타이머가 서버/테스트 종료를 막지 않게
}

app.post('/api/ui-state', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: 'state (JSON object) required' });
  }
  try { scheduleUiStateWrite(body); } catch (e) { console.log('[ui-state] skipped:', e && e.message); }
  res.json({ ok: true });
});

app.get('/api/ui-state', (req, res) => {
  if (uiStateLatest && typeof uiStateLatest === 'object') return res.json(uiStateLatest);
  try {
    if (fs.existsSync(UI_STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(UI_STATE_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return res.json(parsed);
    }
  } catch (_) { /* 깨진 파일은 없는 것으로 본다 */ }
  res.json({});
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    model: MINIMAX_MODEL,
    baseURL: 'https://api.minimax.io/anthropic',
    keysLoaded: MINIMAX_KEYS.length,
    keyPool: MINIMAX_KEYS.map((_, i) => `MINIMAX${i + 1}`)
  });
});

// ─── SPA fallback (only when serving a static frontend) ─────────────────────────
// Any non-/api GET that didn't match a static file returns index.html so client-side
// routing / direct loads work. Registered last so it never shadows the API routes.
// (Avoids Express 5 path-to-regexp wildcard syntax by using a path-less middleware.)
if (STATIC_DIR && fs.existsSync(STATIC_DIR)) {
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
  });
}

// ─── AI 도우미 터미널 (WebSocket PTY) ───────────────────────────────────────────
// /api/terminal 로 붙는 WS 연결마다 실제 셸(PTY)을 띄워 바이트를 양방향 중계한다.
// cwd 는 워크스페이스(파일탐색기/Run 과 동일). run-python 과 같은 로컬 단일 사용자 신뢰 모델.
const wss = new WebSocketServer({ noServer: true });

function pickShell() {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || 'bash';
}

// ── AI 도우미(opencode) 자동 실행 ──────────────────────────────────────────────
// 이 터미널의 목적은 "학생이 AI 에게 물어보는 곳" 이다. 빈 셸 프롬프트를 주면 학생은
// 무엇을 쳐야 할지 모른다 → 열자마자 opencode TUI 가 뜨게 한다.
// 셸을 먼저 띄우고 그 안에서 실행하는 이유(직접 spawn 하지 않는 이유):
//   opencode 를 빠져나오거나 그것이 죽어도 **셸이 남아** 터미널이 통째로 닫히지 않는다
//   (직접 spawn 하면 종료 즉시 WS 가 끊겨 '다시 연결'을 눌러야 한다).
// 끌 때는 BLOCKPY_TERMINAL_AI=0, 다른 명령으로 바꾸려면 BLOCKPY_TERMINAL_CMD=... 로.
function resolveOnPath(bin) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (_) {}
    }
  }
  return null;
}

// 터미널이 열릴 때 셸 안에서 실행할 것. { cmd, dir } 또는 null(그냥 셸).
// **이름이 아니라 절대 경로로 실행한다.** 서버를 Git Bash 에서 띄우면 PATH 가 POSIX 형식
// (`/c/Users/...`)으로 상속돼 자식 PowerShell 이 `opencode` 를 못 찾는다(실측: CommandNotFound).
function terminalBootCommand() {
  if (process.env.BLOCKPY_TERMINAL_AI === '0') return null;
  const custom = (process.env.BLOCKPY_TERMINAL_CMD || '').trim();
  if (custom) return { cmd: custom, dir: null };
  const bin = resolveOnPath('opencode');
  return bin ? { cmd: bin, dir: path.dirname(bin) } : null;
}

function shellArgsFor(shell, boot) {
  if (!boot) return [];
  if (process.platform === 'win32') {
    // -NoExit: boot 가 끝나거나 학생이 opencode 를 나가도 프롬프트가 남는다
    // (직접 spawn 하면 그 순간 터미널이 닫혀 '다시 연결'을 눌러야 한다).
    // & '경로' — 경로에 공백이 있어도 안전하게 호출.
    return shell.toLowerCase().includes('powershell')
      ? ['-NoLogo', '-NoExit', '-Command', `& '${boot.cmd.replace(/'/g, "''")}'`]
      : ['/K', `"${boot.cmd}"`];             // cmd.exe 폴백
  }
  return ['-lc', `'${boot.cmd}'; exec ${shell}`];
}

function attachTerminal(ws) {
  let pty;
  try {
    // 지연 require: 네이티브 빌드가 없더라도 서버의 나머지는 살아있게 한다.
    const nodePty = require('node-pty');
    let shell = pickShell();
    const boot = terminalBootCommand();          // 기본: opencode 절대경로 (AI 도우미 자동 실행)
    // 학생이 opencode 를 나간 뒤 다시 `opencode` 라고 칠 수 있게 그 폴더를 PATH 앞에 붙인다.
    const ptyPath = boot && boot.dir
      ? [boot.dir, process.env.PATH].filter(Boolean).join(path.delimiter)
      : process.env.PATH;
    try {
      pty = nodePty.spawn(shell, shellArgsFor(shell, boot), {
        name: 'xterm-color', cols: 80, rows: 24, cwd: WORKSPACE_DIR,
        env: { ...process.env, PATH: ptyPath, PYTHONIOENCODING: 'utf-8',
          PYTHONPATH: [RUNTIME_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
          BLOCKPY_TERMINAL: '1' },
      });
    } catch (e1) {
      if (process.platform === 'win32') {
        shell = process.env.COMSPEC || 'cmd.exe'; // powershell 실패 시 폴백
        pty = nodePty.spawn(shell, shellArgsFor(shell, boot), {
          name: 'xterm-color', cols: 80, rows: 24, cwd: WORKSPACE_DIR,
          env: { ...process.env,
            PYTHONPATH: [RUNTIME_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
            BLOCKPY_TERMINAL: '1' } });
      } else { throw e1; }
    }
  } catch (e) {
    try { ws.send(`\r\n[터미널을 시작할 수 없습니다: ${e.message}]\r\n`); } catch (_) {}
    try { ws.close(); } catch (_) {}
    return;
  }

  pty.onData((d) => { try { ws.send(d); } catch (_) {} });
  pty.onExit(() => { try { ws.close(); } catch (_) {} });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'i' && typeof msg.d === 'string') { try { pty.write(msg.d); } catch (_) {} }
    else if (msg.t === 'r' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      try { pty.resize(Math.max(1, msg.cols), Math.max(1, msg.rows)); } catch (_) {}
    }
  });

  const kill = () => { try { pty.kill(); } catch (_) {} };
  ws.on('close', kill);
  ws.on('error', kill);
}

wss.on('connection', attachTerminal);

function start(port = process.env.PORT || 3001) {
  return new Promise((resolve) => {
    // Bind LOOPBACK ONLY (127.0.0.1) — never all interfaces. Prevents any other host on the LAN from
    // reaching the run-python/pip/blockify/fs endpoints (unauthenticated RCE + file access otherwise).
    const server = app.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      console.log(`\n🚀 BlockPy Express Server  →  http://127.0.0.1:${actual}`);
      console.log(`🤖 AI Engine: MiniMax-M2.7  (via Anthropic SDK)`);
      console.log(`🔑 Key pool: ${MINIMAX_KEYS.length} key(s) loaded (round-robin)`);
      console.log(`📁 Workspace (file explorer + run cwd): ${WORKSPACE_DIR}\n`);
      seedSampleImages();
      seedStarterFile();
      seedAgentContext();
      resolve({ server, port: actual });
    });
    // WS 업그레이드: /api/terminal 만 처리하고, loopback Host 가 아니면 소켓을 파기한다
    // (Express 의 Host 미들웨어는 WS 업그레이드에 적용되지 않으므로 여기서 직접 검사).
    server.on('upgrade', (req, socket, head) => {
      if (!String(req.url || '').startsWith('/api/terminal')) { socket.destroy(); return; }
      if (!isLoopbackHost(req)) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  });
}

// Run standalone (`node server.js`) → listen immediately. When required by Electron's
// main process, export start() so it can pick a port and await readiness instead.
if (require.main === module) {
  start();
}

module.exports = { app, start, seedAgentContext };
