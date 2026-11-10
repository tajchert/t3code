import {
  DesktopAndroidShareStartInputSchema,
  DesktopAndroidShareStateSchema,
  DesktopAndroidShareStopInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../../devices/androidShareChannels.ts";
import * as DesktopAndroidShare from "../../devices/DesktopAndroidShare.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/**
 * Registers the Android share IPC and unshares every phone when the app's scope closes.
 * Optional so runtimes built without the service (upstream tests) keep working.
 */
export const installAndroidShare = Effect.fn("desktop.ipc.androidShare.install")(function* () {
  const service = yield* Effect.serviceOption(DesktopAndroidShare.DesktopAndroidShare);
  if (Option.isNone(service)) return;
  const androidShare = service.value;
  const ipc = yield* DesktopIpc.DesktopIpc;

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.ANDROID_SHARE_GET_STATE_CHANNEL,
      payload: Schema.Void,
      result: DesktopAndroidShareStateSchema,
      handler: () => androidShare.getState,
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.ANDROID_SHARE_SET_WATCHING_CHANNEL,
      payload: Schema.Boolean,
      result: Schema.Void,
      handler: androidShare.setWatching,
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.ANDROID_SHARE_START_CHANNEL,
      payload: DesktopAndroidShareStartInputSchema,
      result: Schema.Void,
      handler: androidShare.start,
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.ANDROID_SHARE_STOP_CHANNEL,
      payload: DesktopAndroidShareStopInputSchema,
      result: Schema.Void,
      handler: androidShare.stop,
    }),
  );
  // Quit can outrun layer finalizers; the app program's scope closes before quit completes.
  yield* Effect.addFinalizer(() => androidShare.stopAll);
});
