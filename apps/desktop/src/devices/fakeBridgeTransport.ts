import type { AdbBridgeServerFrame } from "@t3tools/contracts";

import type {
  AdbBridgeTransport,
  BridgeTcpHandlers,
  BridgeWebSocketHandlers,
} from "./AdbBridgeConnection.ts";

/** In-memory WebSocket, TCP and timers for tests of the adb bridge. */
export interface FakeWebSocket {
  readonly url: string;
  readonly sent: Array<string | Uint8Array>;
  readonly handlers: BridgeWebSocketHandlers;
  buffered: number;
  closed: boolean;
}

export interface FakeTcpSocket {
  readonly port: number;
  readonly written: Array<Uint8Array>;
  readonly handlers: BridgeTcpHandlers;
  queued: number;
  paused: boolean;
  destroyed: boolean;
}

export const makeFakeTransport = (options: { onWebSocket?: (ws: FakeWebSocket) => void } = {}) => {
  const webSockets: Array<FakeWebSocket> = [];
  const tcpSockets: Array<FakeTcpSocket> = [];
  const timers: Array<{ run: () => void; cancelled: boolean }> = [];
  const transport: AdbBridgeTransport = {
    openWebSocket: (url, handlers) => {
      const ws: FakeWebSocket = { url, sent: [], handlers, buffered: 0, closed: false };
      webSockets.push(ws);
      options.onWebSocket?.(ws);
      return {
        send: (data) => {
          ws.sent.push(data);
        },
        bufferedAmount: () => ws.buffered,
        close: () => {
          ws.closed = true;
        },
      };
    },
    connectTcp: (port, handlers) => {
      const tcp: FakeTcpSocket = {
        port,
        written: [],
        handlers,
        queued: 0,
        paused: false,
        destroyed: false,
      };
      tcpSockets.push(tcp);
      return {
        write: (data) => {
          tcp.written.push(data);
          return true;
        },
        writableLength: () => tcp.queued,
        pause: () => {
          tcp.paused = true;
        },
        resume: () => {
          tcp.paused = false;
        },
        destroy: () => {
          tcp.destroyed = true;
        },
      };
    },
    setTimer: (run) => {
      const timer = { run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return {
    transport,
    webSockets,
    tcpSockets,
    /** Runs every pending timer once. */
    fireTimers: () => {
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
    },
  };
};

export const sendServerFrame = (ws: FakeWebSocket, frame: AdbBridgeServerFrame) =>
  ws.handlers.onMessage(JSON.stringify(frame));

export const textFrames = (ws: FakeWebSocket) =>
  ws.sent.flatMap((data) => (typeof data === "string" ? [JSON.parse(data) as unknown] : []));
