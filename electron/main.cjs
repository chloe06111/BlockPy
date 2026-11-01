// Electron main process — BlockPy desktop (offline-capable) shell.
//
// Boots the embedded Express backend (server.js) on a free localhost port, then opens a
// BrowserWindow pointed at it. Loading over http://127.0.0.1 (not file://) is deliberate:
//   1. the renderer hits /api on the SAME origin (no CORS, no CDN), and
//   2. Express sends COOP/COEP so SharedArrayBuffer / Pyodide work (cross-origin isolation).
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const ICON_PNG = path.join(__dirname, '..', 'build', 'icon.png');

// Tell the embedded server to host the built frontend. MUST be set before requiring
// server.js — it reads BLOCKPY_STATIC_DIR at module-load to register static middleware.
process.env.BLOCKPY_STATIC_DIR = DIST_DIR;
// Quiet the "no AI keys" path by default; .env (if present next to server.js) still wins.
process.env.PYTHONIOENCODING = process.env.PYTHONIOENCODING || 'utf-8';

// Prefer the bundled portable Python (real cv2/numpy/pillow) so the app runs real Python with
// NO system install. Packaged: resources/python/python.exe (electron-builder extraResources).
// Dev: ./python-embed/python.exe if built. Falls back to system python when neither exists.
// Set before requiring server.js, which reads PYTHON_CMD at module-load.
// 온라인 설치본은 무거운 것을 담지 않고 첫 실행 때 userData 아래로 받아 둔다(electron/setup).
// 그래서 후보가 둘이다: ① 오프라인 완본이 담아 온 resources/python ② 온라인 설치본이 받아 둔 userData.
// 먼저 있는 것을 쓴다. 둘 다 없으면 시스템 파이썬으로 물러난다.
const DOWNLOADED_RT = path.join(app.getPath('userData'), 'runtime');
const PY_CANDIDATES = app.isPackaged
  ? [path.join(process.resourcesPath, 'python', 'python.exe'), path.join(DOWNLOADED_RT, 'python', 'python.exe')]
  : [path.join(__dirname, '..', 'python-embed', 'python.exe'), path.join(DOWNLOADED_RT, 'python', 'python.exe')];
const BUNDLED_PY = PY_CANDIDATES.find((p) => fs.existsSync(p)) || PY_CANDIDATES[0];
if (fs.existsSync(BUNDLED_PY)) {
  process.env.PYTHON_CMD = BUNDLED_PY;
  console.log('[python] using bundled runtime:', BUNDLED_PY);
} else if (!process.env.PYTHON_CMD) {
  console.log('[python] bundled runtime not found — falling back to system python');
}

// 배포본에 실린 AI 키를 환경변수로 넘긴다. opencode 는 models.dev 규약대로 DEEPSEEK_API_KEY 를
// 읽으므로, 사용자 홈의 auth.json 을 만들거나 고치지 않아도 바로 답한다(실측: auth.json 없는
// 격리 환경에서 DEEPSEEK_API_KEY 만으로 deepseek/deepseek-v4-flash 응답 확인 — 1.1.1 부터 기본 모델은 deepseek-flash).
// 키 파일(electron/bundled-keys.cjs)은 깃에 없다 — 빌드 때만 asar 에 들어간다.
// 이미 환경변수나 `opencode auth login` 으로 넣은 것이 있으면 그것을 우선한다(덮지 않는다).
try {
  const bundled = require('./bundled-keys.cjs');
  for (const [k, v] of Object.entries(bundled)) {
    if (v && !process.env[k]) {
      process.env[k] = v;
      console.log(`[ai-terminal] bundled key set: ${k} (…${String(v).slice(-4)})`);
    }
  }
} catch (_) {
  console.log('[ai-terminal] no bundled key file — AI 도우미는 사용자가 직접 로그인해야 한다');
}

// Bundled opencode (AI 도우미 터미널). Packaged: resources/opencode/opencode.exe; dev:
// ./opencode-embed/opencode.exe. server.js reads BLOCKPY_TERMINAL_CMD and boots it when a terminal
// opens, so a fresh machine needs NO Node.js and NO `npm i -g opencode-ai` — the binary is
// self-contained (MIT). Falls back to `opencode` on PATH when the bundle is absent.
const OC_CANDIDATES = app.isPackaged
  ? [path.join(process.resourcesPath, 'opencode', 'opencode.exe'), path.join(DOWNLOADED_RT, 'opencode', 'opencode.exe')]
  : [path.join(__dirname, '..', 'opencode-embed', 'opencode.exe'), path.join(DOWNLOADED_RT, 'opencode', 'opencode.exe')];
const BUNDLED_OC = OC_CANDIDATES.find((p) => fs.existsSync(p)) || OC_CANDIDATES[0];
if (!process.env.BLOCKPY_TERMINAL_CMD && fs.existsSync(BUNDLED_OC)) {
  process.env.BLOCKPY_TERMINAL_CMD = BUNDLED_OC;
  console.log('[ai-terminal] using bundled opencode:', BUNDLED_OC);
}

// AI key config (option A): the in-app Settings panel saves the MiniMax key to a per-machine,
// per-user file — NOT bundled into the .exe (a shipped binary carries zero keys). Also read an
// optional pre-seed file placed next to the executable, so a machine can be configured without UI.
// Both set before requiring server.js, which reads them at module-load.
if (!process.env.BLOCKPY_CONFIG) {
  process.env.BLOCKPY_CONFIG = path.join(app.getPath('userData'), 'blockpy-config.json');
}
if (!process.env.BLOCKPY_CONFIG_RO) {
  process.env.BLOCKPY_CONFIG_RO = path.join(path.dirname(process.execPath), 'blockpy-config.json');
}
console.log('[ai] key config:', process.env.BLOCKPY_CONFIG);

// server.js 는 PYTHON_CMD 등을 module-load 때 읽는다. 그래서 첫 실행 준비(ensureRuntimeIfNeeded)가
// 파이썬을 받아 PYTHON_CMD 를 정한 '뒤에' 불러온다 — 맨 위에서 불러오면 첫 실행에 시스템 파이썬으로 굳는다.
function start(port) {
  return require('../server.js').start(port);
}

let mainWindow = null;
let serverInfo = null;

async function createWindow() {
  // Port 0 → OS assigns a free port; server.address().port reports the real one.
  serverInfo = await start(0);
  const url = `http://127.0.0.1:${serverInfo.port}`;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#1f1d1a',
    title: 'BlockPy',
    // Dev: window/taskbar icon. Packaged: the exe icon (build/icon.ico, baked by
    // electron-builder) is used automatically, so this guard just no-ops there.
    ...(fs.existsSync(ICON_PNG) ? { icon: ICON_PNG } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer is a normal web page talking to localhost over fetch — it needs no
      // Node access, so we keep the secure defaults (no preload bridge required).
    },
  });

  // Open external links (docs, etc.) in the system browser, not inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target) && !target.startsWith(url)) {
      shell.openExternal(target);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  await mainWindow.loadURL(url);

  if (process.env.BLOCKPY_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// 온라인 설치본의 첫 실행 준비. 다 갖춰져 있으면(파이썬·꾸러미·AI 도우미·Node.js·Git) 바로 지나간다.
// 1.1.0 은 python.exe 만 보고 건너뛰어서, 꾸러미 설치가 한 번 실패한 PC 는 영영 준비가 안 됐다.
// 이제 빠진 것이 하나라도 있으면 매번 이어서 준비한다(받아 둔 것은 다시 받지 않는다).
// 실패해도 앱은 뜬다: 다음에 켤 때 이어서 한다.
const NL = String.fromCharCode(10);   // 소스에 백슬래시 이스케이프를 두지 않으려고 상수로 쓴다
async function ensureRuntimeIfNeeded() {
  const setup = require('./setup/install.cjs');
  const root = app.getPath('userData');
  const offlineBundle = fs.existsSync(PY_CANDIDATES[0]);       // 오프라인 완본(resources/python) · 개발용 python-embed
  if (!offlineBundle && !setup.isReady(root)) await runSetup(setup, root);
  // AI 도우미 터미널에서 python · pip · node · npx · git 이 BlockPy 것으로 잡히게 PATH 앞에 붙인다.
  const dirs = setup.pathDirs(root);
  if (dirs.length) process.env.PATH = dirs.concat([process.env.PATH || '']).join(path.delimiter);
}

async function runSetup(setup, root) {
  let ui = null;
  try {
    const { ensureRuntime } = setup;
    const { openSetupWindow } = require('./setup/window.cjs');
    ui = openSetupWindow(fs.existsSync(ICON_PNG) ? ICON_PNG : null);
    const res = await ensureRuntime(root, (e) => {
      console.log(`[setup] ${e.step}: ${e.msg}`);
      ui.update(e);
    });
    if (res.warnings && res.warnings.length) {
      console.warn('[setup] 경고:', res.warnings.join(' / '));
      ui.update({ warn: res.warnings.join(NL) });
      await new Promise((r) => setTimeout(r, 2500));           // 경고를 읽을 시간
    }
    // 준비된 것을 이번 실행부터 바로 쓴다(다시 켜지 않아도 되게).
    if (res.pythonExe && fs.existsSync(res.pythonExe)) process.env.PYTHON_CMD = res.pythonExe;
    if (res.opencodeExe && fs.existsSync(res.opencodeExe)) process.env.BLOCKPY_TERMINAL_CMD = res.opencodeExe;
    if (res.weights && fs.existsSync(res.weights)) process.env.BLOCKPY_TM_WEIGHTS = res.weights;
  } catch (e) {
    console.error('[setup] 준비 실패:', e && e.message);
    if (ui) { ui.update({ err: '준비에 실패했습니다: ' + (e && e.message) + NL + '앱은 그대로 열립니다. 인터넷을 확인한 뒤 BlockPy 를 다시 켜면 이어서 준비합니다.' }); await new Promise((r) => setTimeout(r, 15000)); }
  } finally {
    if (ui) ui.close();
  }
}

app.whenReady()
  .then(ensureRuntimeIfNeeded)
  .then(createWindow)
  .catch((err) => {
    console.error('[electron] failed to start:', err);
    app.quit();
  });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  // The embedded Express child dies with the process; standard quit on all platforms but mac.
  if (process.platform !== 'darwin') app.quit();
});
