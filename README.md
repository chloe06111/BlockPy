# BlockPy

> **블록 ⇄ 파이썬 양방향 변환 교육용 플랫폼** — 국립부산과학관 「2026 AI+로보틱스 교육」 수업에서
> 학생들이 블록 코딩과 파이썬을 오가며 로봇팔(Dobot)·티처블머신·AI 도우미를 쓰는 프로그램입니다.
>
> | | |
> |---|---|
> | 주요 기능 | 블록 ↔ 파이썬 무손실 양방향 변환 · 티처블머신(사진 수집·학습) · Dobot 로봇팔 연결과 카메라 보정 · AI 도우미 터미널 · Windows 설치본 |
> | 원저작자 | [shain1912](https://github.com/shain1912) (Harness_Blockly) |
> | 수업용 개선 | 이지호 (코드코리아) — 수업용 개선 8건, 온라인 설치본 (2026-08) |
> | 인수인계 · 유지보수 | [chloe06111](https://github.com/chloe06111) (코드코리아, 2026-09~) |
>
> 수업용으로 바뀐 내용은 [`DOCS/인수인계_변경점_20260811.md`](DOCS/), 인수인계 내용은 [`HANDOVER.md`](HANDOVER.md)에 있습니다.
> 아래는 원래 영어 설명입니다.

---

A **1:1 bidirectional, lossless bridge between Blockly visual blocks and Python text**, wrapped in a
classroom-ready environment: a built-in Teachable-Machine panel, a Dobot robot-arm panel with
camera↔robot calibration, and an AI assistant terminal that can see what the student is doing.

Write Python or drag blocks — the other side updates live, and a round-trip is lossless.
The core is a live **CPython-3.12 `ast` IR pipeline**: Python text is parsed by the real `ast.parse`
(running in Pyodide), serialized to a JSON IR, and mapped to/from `ir_*` Blockly blocks; the reverse
direction rebuilds the ast and emits text via `ast.unparse`. Library blocks come from **runtime
introspection** (blockpy-gen), never from hand-written name tables.

React 19 + Vite frontend, a small Express backend (real-Python runner, introspection, AI proxy,
robot/TM services), and an Electron desktop build.

> Built for the 국립부산과학관 AI·Robotics curriculum. The classroom-facing changes and a full
> upstream diff are documented in Korean under [`DOCS/`](DOCS/) —
> see `인수인계_변경점_20260811.md` (handoff) and `개선계약_20260811.md` (the spec those changes were built to).

---

## Quick start (development)

```bash
npm install
npm run vendor    # copy Blockly/Pyodide/FontAwesome into public/vendor (gitignored — no CDN at runtime)
npm run dev       # frontend  (Vite    :3000)
npm run server    # backend   (Express :3001)   ← run in a second terminal
```

Open <http://localhost:3000>.

`npm start` runs both via `concurrently`, but if one dies it takes the other down with it — during a
class, prefer two terminals.

**Python.** The Run button executes *real local Python* through the backend, so `python` must be on
`PATH` (or set `PYTHON_CMD`). For the classroom features you also need `numpy`, `opencv-python`,
`dobotkit`, and — for Teachable-Machine training — `tensorflow`. The desktop build provisions all of
this for you (see [Desktop app](#desktop-app-online-installer)).

---

## What's in it

### Conversion (the original core)

- **Bidirectional sync** — Python ⇄ blocks, live. Sugar (comprehensions, ternaries, chained
  comparisons) keeps dedicated blocks; an optional Auto-Desugar pass rewrites it into elementary
  loop/conditional blocks.
- **Lossless round-trip** — every CPython-3.12 ast node has a block (raw = 0). The contract is
  `ast.dump(original) == ast.dump(regenerated)`, comments included (formatting is regenerated).
- **Introspected library blocks** — `pip install` or Blockify a module and its functions, methods,
  constants and properties become toolbox blocks. An AI "Curate" flow proposes a purpose-driven ★
  subset with human preview.
- **Gray-block inspector** — lists any raw/unconverted blocks after a conversion and jumps to each.

### Classroom features

- **Teachable Machine panel** — modelled on Google's image project: label cards with thumbnail
  grids, webcam capture ("hold to record") and file upload, a training step with progress and
  advanced settings, and a live preview with per-label probability bars. Saving trains in *Python*
  (`tm.py`, MobileNetV2 transfer learning) and writes a `.npz` the student's program loads with
  `tm.load_model()`.
- **Robot panel** — connect a Dobot Magician Lite / GO through DobotLink, plus a two-stage
  **camera↔robot calibration** for the eye-in-hand rig.
- **`robotvision`** — the Python side of that calibration. `is_ready()`, `find_object(frame)` →
  centre pixel, `to_robot(u, v)` → robot mm. This is what lets a program pick an object up *wherever
  it happens to lie* instead of at a fixed spot.
- **AI assistant terminal** — a PTY on the right-hand side that boots `opencode`. Its behaviour is
  governed by [`agent-context/AGENTS.md`](agent-context/AGENTS.md), which is seeded into the student
  workspace on first run.
- **Staged examples** — each lesson ships as three cumulative steps (find → pick → place), so a
  student can open exactly the stage they are on and it still runs end to end.

### The assistant can see the app

The frontend posts UI state to the backend, which writes it to `<workspace>/.blockpy/state.json`:

```json
{ "tab": "블록 작업실", "file": "main.py", "running": false, "blocks": 21,
  "output_tail": ["분류: 캔 신뢰도: 0.92", "[exit 0]"],
  "robot": { "connected": true, "device": "Magician Lite" },
  "tm": { "labels": ["캔","플라스틱"], "samples": [31, 28], "trained": true },
  "calib": { "ready": true } }
```

`AGENTS.md` tells the assistant to read that file before answering — so "it doesn't work" is
diagnosed from the actual run output instead of a guessing game. Keys are omitted when the app
genuinely doesn't know a value; nothing is invented.

---

## Desktop app (online installer)

```bash
npm run dist      # → release/BlockPy-Setup-<version>.exe   (Windows, NSIS, per-user, no admin)
```

The installer carries the app only. On **first launch** the app downloads and provisions what it
needs into `userData`, showing a progress window:

| Component | Source |
|---|---|
| Python 3.12 (embeddable) + pip | python.org |
| `numpy`, `opencv-python`, `dobotkit`, `websockets`, `tensorflow` | PyPI (versions pinned) |
| `opencode` (AI assistant) | npm (`opencode-windows-x64-baseline`) |
| MobileNetV2 weights | Google storage — lets the first training run offline |
| DobotLink (optional) | Dobot's official update feed; skipped if already installed |

The list, URLs, sizes and checksums live in
[`electron/setup/manifest.json`](electron/setup/manifest.json). Downloads are hash-verified,
retried, and resumable-by-reuse; a corrupted cache is detected and re-fetched.

Why online: bundling everything produced a **1.2 GB** installer. Trade-off — **first launch needs
internet**. Nothing else does. To build a fully offline installer instead, populate `python-embed/`,
`opencode-embed/` and `vendor-installers/` and restore the matching `extraResources` entries in
`package.json`.

`electron/main.cjs` prefers, in order: a bundled runtime under `resources/`, then the downloaded one
under `userData`, then system Python.

---

## Architecture

### Conversion core (`src/utils/*.js`)

`src/main.jsx` imports these for side effects; each attaches a `window.*` global (and `module.exports`
so Node tests can `require()` them).

| Global | File | Responsibility |
|---|---|---|
| `BlockPyAstBridge` | `pyAstBridge.js` | `pythonToIR` / `irToPython` — real `ast.parse` / `ast.unparse` in Pyodide ⇄ JSON IR |
| `BlockPyIR` | `irToBlockly.js`, `blocklyToIr.js` | IR ⇄ Blockly workspace JSON. `NODE_POLICY` categorizes **every** 3.12 ast node |
| — | `irBlocks.js` | All `ir_*` block definitions (mutator-style variable arity) |
| `BlockPyIrToolbox` | `irToolbox.js` | Toolbox built in JS from `IR_TOOLBOX_TABLE` + one category per registered library |
| `BlockPyLibRegistry` | `libRegistry.js` | Introspected calls/constants/properties/macros/curations |
| `BlockPyLibImport` | `libImport.js` | blockpy-gen LibrarySpec → registry specs |
| `BlockPyIrDesugar` | `irDesugar.js` | Optional IR→IR desugar pass |

Blockly and Pyodide are **vendored** under `public/vendor/` (`npm run vendor`) — fully offline.

**Block libraries** ship as introspected specs in `src/data/`: `robotSpecs.json` (dobotkit),
`tmSpecs.json` (tm), `visionSpecs.json` (robotvision).

### Backend (`server.js`)

Binds **127.0.0.1 only** and rejects any request whose `Host` header isn't loopback — it exposes
unauthenticated run-python/pip/file endpoints and a terminal, and must never be reachable off-box.

| Endpoint | Purpose |
|---|---|
| `POST /api/run-python` | Run real Python, stream stdout/stderr (cwd = workspace) |
| `POST /api/blockify`, `/api/deps`, `/api/infer-types`, `/api/pip-install` | Introspection & typing |
| `GET/POST /api/fs/*` | Workspace file explorer |
| `WS /api/terminal` | PTY for the AI assistant (boots `opencode`) |
| `POST /api/tm/train` | Train a `.npz` from collected samples |
| `GET /api/tm/prepare-status` | Progress while TensorFlow is being installed on demand |
| `POST /api/robot/connect`, `/disconnect`, `/ports`, `/move-preset` | Robot panel |
| `POST /api/robot/safe-stop` | **Turn the pump off** — called by the Stop button |
| `GET/POST /api/robot/calib` | Read/write `robot_calib.json` so Python can use the calibration |
| `GET /api/cameras` | Report which `cv2.VideoCapture` indices actually open |
| `GET/POST /api/ui-state` | App state for the AI assistant (`.blockpy/state.json`) |
| `POST /api/ai-*`, `/api/abstract-library` | AI proxy (503 without keys) |

AI keys come from `.env` (`MINIMAX1`..`MINIMAX4`) or the in-app Settings file (`BLOCKPY_CONFIG`).
Everything except the AI endpoints works without keys.

**Env:** `BLOCKPY_WORKSPACE` (file root + run cwd; default `~/BlockPyWorkspace`), `PYTHON_CMD`,
`BLOCKIFY_ALLOW`, `BLOCKPY_TERMINAL_CMD`, `BLOCKPY_TERMINAL_AI=0`, `BLOCKPY_TM_WEIGHTS`, `BLOCKPY_STATIC_DIR`.

### The workspace

`~/BlockPyWorkspace` is what the file panel shows *and* the cwd programs run in. Seeded on first run
(never overwriting existing files): `AGENTS.md`, `CLAUDE.md`, `opencode.jsonc`, `examples/`.
Created as you work: `<name>.npz` (trained models), `robot_calib.json` (calibration),
`.blockpy/state.json` (app state).

> Because seeding never overwrites, **an existing workspace does not pick up new `AGENTS.md` rules** —
> delete the file and restart to refresh it.

---

## Project structure

```
src/
  utils/           conversion core (ast IR pipeline) + affineCalib.js
  components/      BlocklyEditor, PythonEditor, TeachableMachine, RobotConnect,
                   RobotCalibrate, FileExplorer, ConsoleLogs, ExampleGallery…
  data/            introspected block specs (robot / tm / vision) + robotCalib.default.json
  examples/        gallery registry (lessons.js, snippets.js)
runtime/           Python the student's program imports: tm.py, robotvision.py
public/examples/   lesson programs — three cumulative stages per lesson
electron/          desktop shell
  setup/           online-installer: manifest.json, download.cjs, install.cjs, window.cjs
agent-context/     AGENTS.md + opencode.jsonc seeded into the workspace
blockpy-gen/       introspection engine (own node --test suite)
tools/             capture/verification scripts used to build the courseware
DOCS/              handoff notes and the improvement spec (Korean)
```

---

## Testing

```bash
npm run test:ir     # IR pipeline gate — 186 specs. CI merge gate
npm run test:gen    # blockpy-gen unit tests (node --test). CI merge gate
npm test            # full Playwright suite
node --test tests/*.test.mjs     # terminal, TM pack, grounding, url tests
```

**`test:ir` needs the backend running** (`npm run server`) — three specs hit `/api`, and
`playwright.config.js` only starts Vite. Without it you get 183/186 and three connection errors.

`agent_grounding.test.mjs` is worth knowing about: it checks that every API mentioned in
`AGENTS.md` actually exists in `robotSpecs.json` / `tm.py`, so the assistant can't be taught a
function that isn't real.

---

## Known limitations

- **First launch needs internet** (online installer). Everything after that is offline.
- **DobotLink is third-party** (Dobot). It is downloaded from the vendor's own feed rather than
  redistributed; check Dobot's terms before shipping it inside anything.
- **`WS /api/terminal` has no authentication.** Its only defences are the loopback bind and the Host
  check; it hands out a shell in the workspace directory.
- **`scripts/bundle-python.py`'s package list has drifted** from what the runtime actually needs, so
  an offline build isn't reproducible from a clean clone yet.
- The high-school examples dropped their `try/except` hardware guards for block-conversion
  friendliness — a disconnected robot shows a raw traceback.
- Legacy: the pre-IR hand-written parser is **gone**; `blocklyToIr` throws on any non-`ir_*` block.
  Older notes under `papers/` describe that removed design — trust `src/`.

## License

MIT, as declared in `package.json` — but there is **no `LICENSE` file** in the repository.
Third-party components fetched by the installer keep their own licenses (opencode is MIT;
DobotLink is Dobot's proprietary software and is downloaded from the vendor, not redistributed here).
