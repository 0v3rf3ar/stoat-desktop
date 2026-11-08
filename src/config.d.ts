declare type DesktopConfig = {
  firstLaunch: boolean;
  customFrame: boolean;
  minimiseToTray: boolean;
  spellchecker: boolean;
  hardwareAcceleration: boolean;
  discordRpc: boolean;
  /** chosen Stoat instance, empty until picked */
  serverUrl: string;
  pushToTalk: boolean;
  /** KeyboardEvent.code-style name, e.g. "KeyV", "F8", "Mouse4" */
  pushToTalkKeybind: string;
  pushToTalkMode: "hold" | "toggle";
  /** ms to keep transmitting after the key is released */
  pushToTalkReleaseDelay: number;
  windowState: {
    x: number;
    y: number;
    width: number;
    height: number;
    isMaximised: boolean;
  };
};
