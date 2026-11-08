/**
 * Self-contained page shown before connecting, used to pick which
 * Stoat instance to use (official or self-hosted).
 */
export function serverPickerHtml(options: {
  official: string;
  current?: string;
  error?: string;
  canCancel: boolean;
}) {
  const data = JSON.stringify(options).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<title>Stoat</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #191919;
    --surface: #242424;
    --surface-hi: #2e2e2e;
    --border: #3a3a3a;
    --text: #ececec;
    --muted: #a3a3a3;
    --accent: #ff7a59;
    --accent-text: #1a0d08;
    --error: #ff8a80;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: grid;
    place-items: center;
    padding: 16px;
    -webkit-app-region: drag;
  }
  main {
    width: 100%;
    max-width: 440px;
    -webkit-app-region: no-drag;
  }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
  p.lead { color: var(--muted); margin: 0 0 24px; }
  .options { display: flex; flex-direction: column; gap: 4px; border-radius: 20px; overflow: hidden; }
  label.option {
    display: flex; gap: 14px; align-items: flex-start;
    padding: 14px 16px;
    background: var(--surface);
    cursor: pointer;
    border-radius: 6px;
  }
  label.option:hover { background: var(--surface-hi); }
  label.option input[type=radio] { margin: 3px 0 0; accent-color: var(--accent); width: 16px; height: 16px; flex-shrink: 0; }
  .title { font-weight: 600; }
  .desc { color: var(--muted); font-size: 13px; }
  .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
  input#url {
    width: 100%;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  input#url:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  input#url:disabled { opacity: .5; }
  .error { color: var(--error); min-height: 20px; margin: 12px 2px 0; font-size: 13px; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
  button {
    font: inherit; font-weight: 600;
    padding: 10px 20px;
    border-radius: 999px;
    border: 0;
    cursor: pointer;
  }
  button.primary { background: var(--accent); color: var(--accent-text); }
  button.secondary { background: var(--surface-hi); color: var(--text); }
  button:disabled { opacity: .6; cursor: progress; }
  .hint { color: var(--muted); font-size: 12px; margin-top: 16px; text-align: center; }
</style>
</head>
<body>
<main>
  <h1>Choose a server</h1>
  <p class="lead">Pick which Stoat instance to connect to.</p>
  <div id="form">
    <div class="options">
      <label class="option">
        <input type="radio" name="server" value="official" id="official" />
        <div class="body">
          <span class="title">Stoat</span>
          <span class="desc" id="official-desc"></span>
        </div>
      </label>
      <label class="option">
        <input type="radio" name="server" value="custom" id="custom" />
        <div class="body">
          <span class="title">Self-hosted</span>
          <span class="desc">Connect to your own Stoat instance.</span>
          <input type="text" inputmode="url" id="url" placeholder="https://chat.example.com" spellcheck="false" autocomplete="url" />
        </div>
      </label>
    </div>
    <div class="error" id="error" role="alert"></div>
    <div class="actions">
      <button type="button" class="secondary" id="cancel" hidden>Cancel</button>
      <button type="button" class="primary" id="connect">Connect</button>
    </div>
  </div>
  <p class="hint">You can change this later in Settings → Desktop.</p>
</main>
<script>
  const opts = ${data};
  const $ = (id) => document.getElementById(id);
  const official = $("official"), custom = $("custom"), url = $("url");
  const error = $("error"), connect = $("connect"), cancel = $("cancel");

  $("official-desc").textContent = new URL(opts.official).host + " — the official instance";

  const isCustom = !!opts.current && new URL(opts.current).origin !== new URL(opts.official).origin;
  url.value = isCustom ? opts.current : "";
  (isCustom ? custom : official).checked = true;
  if (opts.error) error.textContent = opts.error;
  if (opts.canCancel) cancel.hidden = false;

  const sync = () => { url.disabled = !custom.checked; };
  official.addEventListener("change", sync);
  custom.addEventListener("change", () => { sync(); url.focus(); });
  url.addEventListener("focus", () => { custom.checked = true; sync(); });
  sync();

  cancel.addEventListener("click", () => window.serverPicker.cancel());

  let busy = false;
  async function submit() {
    if (busy) return;
    const target = official.checked ? opts.official : url.value.trim();
    if (!target) { error.textContent = "Enter the address of your server."; url.focus(); return; }

    error.textContent = "";
    busy = true;
    connect.disabled = true;
    connect.textContent = "Connecting…";
    try {
      const result = await window.serverPicker.choose(target);
      if (result && result.error) error.textContent = result.error;
    } catch (err) {
      error.textContent = String(err && err.message || err);
    } finally {
      busy = false;
      connect.disabled = false;
      connect.textContent = "Connect";
    }
  }

  connect.addEventListener("click", submit);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); submit(); }
  });
</script>
</body>
</html>`;
}
