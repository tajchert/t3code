import type { DesktopBridge, DesktopAndroidShareState } from "@t3tools/contracts";
import { ipcRenderer } from "electron";

import * as Channels from "./androidShareChannels.ts";

export const androidShareBridge = {
  getAndroidShareState: () => ipcRenderer.invoke(Channels.ANDROID_SHARE_GET_STATE_CHANNEL),
  setAndroidShareWatching: (watching) =>
    ipcRenderer.invoke(Channels.ANDROID_SHARE_SET_WATCHING_CHANNEL, watching),
  startAndroidShare: (input) => ipcRenderer.invoke(Channels.ANDROID_SHARE_START_CHANNEL, input),
  stopAndroidShare: (input) => ipcRenderer.invoke(Channels.ANDROID_SHARE_STOP_CHANNEL, input),
  onAndroidShareState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as DesktopAndroidShareState);
    };
    ipcRenderer.on(Channels.ANDROID_SHARE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(Channels.ANDROID_SHARE_STATE_CHANNEL, wrappedListener);
    };
  },
} satisfies Pick<
  DesktopBridge,
  | "getAndroidShareState"
  | "setAndroidShareWatching"
  | "startAndroidShare"
  | "stopAndroidShare"
  | "onAndroidShareState"
>;
