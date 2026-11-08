import { contextBridge, ipcRenderer } from "electron";

type PushToTalkState = {
  enabled: boolean;
  open: boolean;
  keybind: string;
  global: boolean;
};

let state: PushToTalkState = {
  enabled: false,
  open: false,
  keybind: "",
  global: false,
};
const listeners = new Set<(state: PushToTalkState) => void>();

function update(newState: PushToTalkState) {
  state = newState;
  listeners.forEach((cb) => {
    try {
      cb(state);
    } catch (err) {
      console.error("[PTT] listener error", err);
    }
  });
}

ipcRenderer.on("pushToTalk", (_, newState: PushToTalkState) =>
  update(newState),
);

ipcRenderer
  .invoke("pushToTalk:getState")
  .then((newState: PushToTalkState) => update(newState))
  .catch(() => {
    // main process not ready
  });

contextBridge.exposeInMainWorld("pushToTalk", {
  isAvailable: () => true,
  getState: () => state,
  onStateChange(cb: (state: PushToTalkState) => void) {
    listeners.add(cb);
    cb(state);
  },
  offStateChange(cb: (state: PushToTalkState) => void) {
    listeners.delete(cb);
  },
  setEnabled: (enabled: boolean) =>
    ipcRenderer.send("config", { pushToTalk: !!enabled }),
  setKeybind: (code: string) =>
    ipcRenderer.send("config", { pushToTalkKeybind: String(code) }),
  input: (code: string, down: boolean) =>
    ipcRenderer.send("pushToTalk:input", String(code), !!down),
});

/**
 * Runs in the page's own world, before any page scripts.
 * Must be self-contained: it is serialised and evaluated in the page.
 */
function installMainWorld() {
  type State = {
    enabled: boolean;
    open: boolean;
    keybind: string;
    global: boolean;
  };

  const api = (
    window as unknown as {
      pushToTalk: {
        getState(): State;
        onStateChange(cb: (s: State) => void): void;
        setEnabled(enabled: boolean): void;
        setKeybind(code: string): void;
        input(code: string, down: boolean): void;
      };
    }
  ).pushToTalk;

  const server = (
    window as unknown as {
      desktopServer?: { get(): Promise<string | null>; change(): void };
    }
  ).desktopServer;

  let state: State = api.getState();
  const renderers = new Set<() => void>();

  // ------------------------------------------------------------------
  // Microphone gate
  //
  // Every microphone track handed out by getUserMedia has its `enabled`
  // property intercepted: the page still sees and controls its own value
  // (so the client's mute button keeps working), while the real value is
  // `pageValue && (push-to-talk off || key held)`.
  // ------------------------------------------------------------------

  const enabledDescriptor = Object.getOwnPropertyDescriptor(
    MediaStreamTrack.prototype,
    "enabled",
  );
  const getEnabled = enabledDescriptor?.get;
  const setEnabled = enabledDescriptor?.set;
  const mediaDevices = navigator.mediaDevices;

  const pageEnabled = new WeakMap<MediaStreamTrack, boolean>();
  const tracks = new Set<WeakRef<MediaStreamTrack>>();

  const apply = (track: MediaStreamTrack) =>
    setEnabled?.call(
      track,
      !!pageEnabled.get(track) && (!state.enabled || state.open),
    );

  const wrap = (track: MediaStreamTrack, initial?: boolean) => {
    if (!getEnabled || track.kind !== "audio" || pageEnabled.has(track)) return;
    // don't gate the desktop's virtual source used for screen share audio
    if (/stoat-virtual/i.test(track.label)) return;

    pageEnabled.set(track, initial ?? (getEnabled.call(track) as boolean));

    Object.defineProperty(track, "enabled", {
      configurable: true,
      enumerable: true,
      get: () => pageEnabled.get(track),
      set: (value: boolean) => {
        pageEnabled.set(track, !!value);
        apply(track);
      },
    });

    tracks.add(new WeakRef(track));
    apply(track);
  };

  if (getEnabled && setEnabled && mediaDevices) {
    const getUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    mediaDevices.getUserMedia = async (
      constraints?: MediaStreamConstraints,
    ) => {
      const stream = await getUserMedia(constraints);
      stream.getAudioTracks().forEach((track) => wrap(track));
      return stream;
    };

    const clone = MediaStreamTrack.prototype.clone;
    MediaStreamTrack.prototype.clone = function (this: MediaStreamTrack) {
      const copy = clone.call(this);
      if (pageEnabled.has(this)) wrap(copy, pageEnabled.get(this));
      return copy;
    };
  }

  api.onStateChange((newState) => {
    state = newState;

    for (const ref of tracks) {
      const track = ref.deref();
      if (!track || track.readyState === "ended") {
        tracks.delete(ref);
      } else {
        apply(track);
      }
    }

    renderers.forEach((render) => render());
  });

  // ------------------------------------------------------------------
  // Mouse buttons as push-to-talk key (while focused, without the
  // global listener the main process can't see them)
  // ------------------------------------------------------------------

  const MOUSE_BUTTONS: Record<number, string> = {
    1: "MouseMiddle",
    3: "Mouse4",
    4: "Mouse5",
  };

  let capturing = false;

  for (const type of ["mousedown", "mouseup"] as const) {
    window.addEventListener(
      type,
      (event) => {
        const code = MOUSE_BUTTONS[event.button];
        if (capturing || !code || !state.enabled || code !== state.keybind) {
          return;
        }
        api.input(code, type === "mousedown");
      },
      true,
    );
  }

  // ------------------------------------------------------------------
  // Settings UI, injected into the client's own settings pages:
  //  - Voice & Video: push-to-talk toggle + key
  //  - Desktop: server selection
  // Rows copy the class names of the client's own rows so they match.
  // ------------------------------------------------------------------

  const KEY_NAMES: Record<string, string> = {
    ControlLeft: "Left Ctrl",
    ControlRight: "Right Ctrl",
    ShiftLeft: "Left Shift",
    ShiftRight: "Right Shift",
    AltLeft: "Left Alt",
    AltRight: "Right Alt",
    MetaLeft: "Left Super",
    MetaRight: "Right Super",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    CapsLock: "Caps Lock",
    MouseMiddle: "Middle Mouse",
    Mouse4: "Mouse 4 (Back)",
    Mouse5: "Mouse 5 (Forward)",
  };

  const describeKey = (code: string) =>
    KEY_NAMES[code] ??
    code
      .replace(/^Key([A-Z])$/, "$1")
      .replace(/^Digit(\d)$/, "$1")
      .replace(/^Numpad(.+)$/, "Numpad $1")
      .replace(/^Arrow(.+)$/, "$1 Arrow");

  type Template = {
    group: string;
    row: string;
    iconWrap: string;
    symbol: string;
    content: string;
    title: string;
    description: string;
  };

  /** find the Material Symbol <span> with this icon name inside a row */
  const findSymbol = (name: string) =>
    document.evaluate(
      `//a//span[normalize-space(text())='${name}']`,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue as HTMLSpanElement | null;

  function templateFrom(symbol: HTMLSpanElement, group: Element): Template {
    const row = symbol.closest("a")!;
    const iconWrap = symbol.parentElement!;
    const content = iconWrap.nextElementSibling;
    const description = document.evaluate(
      "//a/div/span[normalize-space(text())!='']",
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue as Element | null;

    return {
      group: group.className,
      row: row.className,
      iconWrap: iconWrap.className,
      symbol: symbol.className,
      content: content?.className ?? "",
      title: content?.firstElementChild?.className ?? "",
      description: description?.className ?? "",
    };
  }

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    fallback: string,
    text?: string,
  ) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    else element.style.cssText = fallback;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function pill(text = "") {
    const element = document.createElement("span");
    element.style.cssText =
      "flex-shrink:0;padding:6px 14px;border-radius:var(--borderRadius-full,999px);" +
      "background:var(--md-sys-color-surface-dim);color:var(--md-sys-color-on-surface);" +
      "font-weight:500;font-size:13px;white-space:nowrap";
    element.textContent = text;
    return element;
  }

  function makeRow(
    t: Template,
    options: {
      icon: string;
      title: string;
      action: HTMLElement;
      onClick: () => void;
    },
  ) {
    const row = el(
      "a",
      t.row,
      "position:relative;display:flex;align-items:center;gap:16px;padding:13px;" +
        "border-radius:var(--borderRadius-md);background:var(--md-sys-color-secondary-container);" +
        "color:var(--md-sys-color-on-secondary-container)",
    );
    row.style.cursor = "pointer";
    row.dataset.stoatRow = "";

    const iconWrap = el(
      "div",
      t.iconWrap,
      "width:36px;height:36px;flex-shrink:0;display:flex;align-items:center;" +
        "justify-content:center;border-radius:var(--borderRadius-full);" +
        "background:var(--md-sys-color-surface-dim)",
    );
    iconWrap.append(el("span", t.symbol, "", options.icon));

    const content = el(
      "div",
      t.content,
      "display:flex;flex-grow:1;flex-direction:column;gap:2px;font-weight:500;" +
        "font-size:14px;overflow:hidden",
    );
    const title = el("div", t.title, "", options.title);
    const description = el(
      "span",
      t.description,
      "font-size:12px;font-weight:400;text-wrap:wrap;opacity:.8",
    );
    content.append(title, description);

    row.append(iconWrap, content, options.action);
    row.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onClick();
    });

    return { row, description };
  }

  function makeCheckbox() {
    if (customElements.get("mdui-checkbox")) {
      const checkbox = document.createElement(
        "mdui-checkbox",
      ) as HTMLElement & {
        checked: boolean;
      };
      checkbox.style.pointerEvents = "none";
      return checkbox;
    }

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.style.pointerEvents = "none";
    return checkbox;
  }

  function captureKey(onDone: (code?: string) => void) {
    capturing = true;
    const timeout = setTimeout(() => finish(), 15000);

    function finish(code?: string) {
      capturing = false;
      clearTimeout(timeout);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      if (code) {
        // swallow the matching key-up too
        const onKeyUp = (event: KeyboardEvent) => {
          if (event.code !== code) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          window.removeEventListener("keyup", onKeyUp, true);
        };
        window.addEventListener("keyup", onKeyUp, true);
      }
      onDone(code);
    }

    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      finish(event.code === "Escape" ? undefined : event.code || undefined);
    }

    function onMouseDown(event: MouseEvent) {
      const code = MOUSE_BUTTONS[event.button];
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(code);
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onMouseDown, true);
  }

  function injectPushToTalk() {
    if (document.querySelector("[data-stoat-ptt]")) return;

    const mic = findSymbol("mic");
    const speaker = findSymbol("speaker");
    if (!mic || !speaker) return;

    // the group holding the input / output device rows
    let group: Element | null = mic.closest("a");
    for (let depth = 0; group && !group.contains(speaker); depth++) {
      group = depth < 4 ? group.parentElement : null;
    }
    const column = group?.parentElement;
    if (!group || !column) return;

    const t = templateFrom(mic, group);
    const section = el(
      "div",
      t.group,
      "display:flex;flex-direction:column;gap:var(--gap-xs);" +
        "border-radius:var(--borderRadius-xl);overflow:hidden",
    );
    section.dataset.stoatPtt = "";

    const checkbox = makeCheckbox() as HTMLElement & { checked: boolean };
    const toggle = makeRow(t, {
      icon: "settings_voice",
      title: "Push to Talk",
      action: checkbox,
      onClick: () => api.setEnabled(!state.enabled),
    });

    let waiting = false;
    const keyPill = pill();
    const key = makeRow(t, {
      icon: "keyboard",
      title: "Push to Talk Key",
      action: keyPill,
      onClick: () => {
        if (waiting) return;
        waiting = true;
        render();
        captureKey((code) => {
          waiting = false;
          if (code) api.setKeybind(code);
          render();
        });
      },
    });

    function render() {
      if (!section.isConnected) {
        renderers.delete(render);
        return;
      }

      checkbox.checked = state.enabled;
      toggle.description.textContent = state.enabled
        ? "Your microphone only transmits while you hold the key."
        : "Off — your microphone transmits whenever you're unmuted.";

      keyPill.textContent = waiting
        ? "Press a key…"
        : describeKey(state.keybind);
      key.description.textContent = waiting
        ? "Press any key or mouse button. Esc to cancel."
        : state.global
          ? "Click to change. Works even when Stoat isn't focused."
          : state.enabled
            ? "Click to change. Works while Stoat is focused — add your user to the 'input' group for a global hotkey."
            : "Click to change.";
      key.row.style.opacity = state.enabled || waiting ? "" : "0.6";
    }

    section.append(toggle.row, key.row);
    column.after(section);
    renderers.add(render);
    render();
  }

  function injectServer() {
    if (!server || document.querySelector("[data-stoat-server]")) return;

    // the "Stoat for Desktop" version row on the Desktop settings page
    const symbol = findSymbol("desktop_windows");
    const group = symbol?.closest("a")?.parentElement;
    if (!symbol || !group) return;

    const t = templateFrom(symbol, group);
    const section = el(
      "div",
      t.group,
      "display:flex;flex-direction:column;gap:var(--gap-xs);" +
        "border-radius:var(--borderRadius-xl);overflow:hidden",
    );
    section.dataset.stoatServer = "";

    const row = makeRow(t, {
      icon: "dns",
      title: "Server",
      action: pill("Change"),
      onClick: () => server.change(),
    });

    server.get().then((url) => {
      row.description.textContent = url ?? "";
    });

    section.append(row.row);
    group.before(section);
  }

  const style = document.createElement("style");
  style.textContent =
    "[data-stoat-row]:hover{filter:brightness(1.1)}" +
    "[data-stoat-row]{transition:filter .1s ease-in-out}";

  let scheduled = false;
  const check = () => {
    scheduled = false;
    if (!style.isConnected && document.head) document.head.append(style);
    injectPushToTalk();
    injectServer();
  };

  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(check, 150);
  }).observe(document, { childList: true, subtree: true });
}

// the server picker page gets its own API instead
if (location.protocol !== "data:") {
  contextBridge.executeInMainWorld({ func: installMainWorld });
}
