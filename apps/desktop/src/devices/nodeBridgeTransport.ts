// @effect-diagnostics nodeBuiltinImport:off -- Byte pumping uses raw sockets so the local adb stream can be paused.
// @effect-diagnostics globalTimers:off -- The drain check runs inside socket callbacks, outside any fiber.
import * as NodeNet from "node:net";

import type { AdbBridgeTransport } from "./AdbBridgeConnection.ts";

/**
 * Node's global `WebSocket` (Electron main has one, so `ws` is not needed) and a loopback TCP
 * socket to the `adb forward` port.
 */
export const nodeBridgeTransport: AdbBridgeTransport = {
  openWebSocket: (url, handlers) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data === "string") handlers.onMessage(data);
      else if (data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(data));
    });
    // `close` always follows `error` and reports the drop.
    socket.addEventListener("error", () => undefined);
    socket.addEventListener("close", (event: CloseEvent) =>
      handlers.onClose(event.reason || `The connection closed (code ${event.code}).`),
    );
    return {
      send: (data) => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(data as string | Uint8Array<ArrayBuffer>);
      },
      bufferedAmount: () => socket.bufferedAmount,
      close: () => socket.close(1000),
    };
  },
  connectTcp: (port, handlers) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port });
    socket.setNoDelay(true);
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      socket.destroy();
      handlers.onEnded();
    };
    socket.on("data", (chunk: Buffer) => handlers.onData(chunk));
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", end);
    return {
      write: (data) => socket.write(data),
      writableLength: () => socket.writableLength,
      pause: () => socket.pause(),
      resume: () => socket.resume(),
      destroy: () => socket.destroy(),
    };
  },
  setTimer: (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};
