// 첫 실행 준비 화면.
//
// 온라인 설치본은 앱 본체만 담고 무거운 것(파이썬·AI 도우미·tensorflow·DobotLink)은 첫 실행 때 받는다.
// 그동안 빈 창을 띄우면 사용자는 멈춘 줄 안다. 그래서 작은 창에 진행 상황을 그대로 보여 준다.
//
// 외부 파일을 읽지 않고 data URL 로 띄운다 — 준비가 끝나기 전이라 dist 를 아직 쓸 수 없기 때문이다.
const { BrowserWindow } = require('electron');

const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>BlockPy 준비 중</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font-family:"Malgun Gothic","Segoe UI",sans-serif; background:#f2f4f7; color:#2c313d;
         display:flex; align-items:center; justify-content:center; height:100vh; }
  .box { width:520px; padding:28px 32px; background:#fff; border:1px solid #e2e2e2; border-radius:8px; }
  h1 { font-size:19px; margin:0 0 6px; }
  .sub { font-size:13px; color:#5b6670; margin:0 0 18px; }
  .step { font-size:14px; margin:10px 0 6px; font-weight:700; }
  .msg { font-size:13px; color:#5b6670; min-height:1.4em; word-break:break-all; }
  .bar { height:8px; background:#eceef2; border-radius:999px; overflow:hidden; margin:12px 0 4px; }
  .fill { height:100%; width:0%; background:#4f80ff; transition:width .25s; }
  .warn { margin-top:14px; font-size:12.5px; color:#a9531d; white-space:pre-wrap; }
  .err { margin-top:14px; font-size:13px; color:#b3261e; white-space:pre-wrap; }
  @media (prefers-color-scheme: dark) {
    body { background:#1b1e24; color:#e6e8ec; }
    .box { background:#262c38; border-color:#39404d; }
    .sub, .msg { color:#a4adba; }
    .bar { background:#39404d; }
  }
</style></head><body>
<div class="box">
  <h1>BlockPy 를 준비하고 있어요</h1>
  <p class="sub">처음 한 번만 합니다. 인터넷에서 필요한 것을 내려받는 중이에요.</p>
  <div class="step" id="step">시작하는 중…</div>
  <div class="bar"><div class="fill" id="fill"></div></div>
  <div class="msg" id="msg"></div>
  <div class="warn" id="warn"></div>
  <div class="err" id="err"></div>
</div>
<script>
  const LABEL = { python: '파이썬', opencode: 'AI 도우미', mobilenet: 'AI 학습 밑바탕', dobotlink: '로봇팔 연결 프로그램', node: 'Node.js', git: 'Git' };
  window.__setup = (e) => {
    if (e.step) document.getElementById('step').textContent = (LABEL[e.step] || e.step) + ' 준비';
    if (e.msg) document.getElementById('msg').textContent = e.msg;
    if (typeof e.percent === 'number') document.getElementById('fill').style.width = e.percent + '%';
    if (e.warn) document.getElementById('warn').textContent = e.warn;
    if (e.err) document.getElementById('err').textContent = e.err;
  };
</script></body></html>`;

function openSetupWindow(iconPath) {
  const win = new BrowserWindow({
    width: 600, height: 340, resizable: false, minimizable: true, maximizable: false,
    title: 'BlockPy 준비 중', backgroundColor: '#f2f4f7',
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setMenu(null);
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  return {
    win,
    // 렌더러에 진행 상황을 넘긴다. 창이 이미 닫혔으면 조용히 무시한다.
    update(e) {
      if (win.isDestroyed()) return;
      win.webContents.executeJavaScript(
        'window.__setup && window.__setup(' + JSON.stringify(e) + ')',
      ).catch(() => { /* 로딩 전이면 무시 */ });
    },
    close() { if (!win.isDestroyed()) win.close(); },
  };
}

module.exports = { openSetupWindow };
