import {
  AdbBridgeServerFrame,
  type AdbBridgeClientFrame,
  type AdbBridgeRemoteStatus,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * One TCP stream at a time. `closing` means we sent `close` and drop binary frames until the
 * environment answers `closed`. `id` tells a stale TCP socket's events from the current one's.
 */
interface BridgeStreamState {
  readonly phase: "idle" | "open" | "closing";
  readonly id: number;
}

type BridgeStreamInput =
  | { readonly type: "server-open" }
  | { readonly type: "server-close" }
  | { readonly type: "server-closed" }
  | { readonly type: "tcp-ended"; readonly id: number };

type BridgeStreamEffect =
  | { readonly type: "connect-tcp"; readonly id: number }
  | { readonly type: "destroy-tcp" }
  | { readonly type: "send"; readonly frame: AdbBridgeClientFrame["type"] };

const initialBridgeStream: BridgeStreamState = { phase: "idle", id: 0 };

const stepBridgeStream = (
  state: BridgeStreamState,
  input: BridgeStreamInput,
): readonly [BridgeStreamState, ReadonlyArray<BridgeStreamEffect>] => {
  switch (input.type) {
    case "server-open": {
      if (state.phase !== "idle") return [state, []];
      const id = state.id + 1;
      return [{ phase: "open", id }, [{ type: "connect-tcp", id }]];
    }
    case "server-close":
      if (state.phase === "open") {
        return [
          { phase: "idle", id: state.id },
          [{ type: "destroy-tcp" }, { type: "send", frame: "closed" }],
        ];
      }
      // Both ends closed at once: answer theirs and keep waiting for our own `closed`.
      if (state.phase === "closing") return [state, [{ type: "send", frame: "closed" }]];
      return [state, []];
    case "server-closed":
      return state.phase === "closing" ? [{ phase: "idle", id: state.id }, []] : [state, []];
    case "tcp-ended":
      if (state.phase !== "open" || input.id !== state.id) return [state, []];
      return [
        { phase: "closing", id: state.id },
        [{ type: "destroy-tcp" }, { type: "send", frame: "close" }],
      ];
  }
};

export interface BridgeWebSocket {
  readonly send: (data: string | Uint8Array) => void;
  readonly bufferedAmount: () => number;
  readonly close: () => void;
}

export interface BridgeWebSocketHandlers {
  readonly onMessage: (data: string | Uint8Array) => void;
  readonly onClose: (detail: string) => void;
}

export interface BridgeTcpSocket {
  /** False when the write was queued in memory instead of flushed. */
  readonly write: (data: Uint8Array) => boolean;
  readonly writableLength: () => number;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly destroy: () => void;
}

export interface BridgeTcpHandlers {
  readonly onData: (data: Uint8Array) => void;
  /** The socket failed to connect, ended or errored. Fires at most once. */
  readonly onEnded: () => void;
}

export interface AdbBridgeTransport {
  readonly openWebSocket: (url: string, handlers: BridgeWebSocketHandlers) => BridgeWebSocket;
  readonly connectTcp: (port: number, handlers: BridgeTcpHandlers) => BridgeTcpSocket;
  readonly setTimer: (run: () => void, ms: number) => () => void;
}

export interface AdbBridgeStatusFrame {
  readonly status: AdbBridgeRemoteStatus;
  readonly remoteSerial?: string | undefined;
  readonly detail?: string | undefined;
}

export interface AdbBridgeConnectionCallbacks {
  readonly onStatus: (frame: AdbBridgeStatusFrame) => void;
  /** The WebSocket closed without `close()` being called. */
  readonly onDropped: (detail: string) => void;
}

export interface AdbBridgeConnection {
  readonly close: () => void;
}

// Pause the local adb socket while this much is queued on the WebSocket.
const WEBSOCKET_HIGH_WATER = 4 * 1024 * 1024;
const WEBSOCKET_LOW_WATER = 1024 * 1024;
const WEBSOCKET_DRAIN_CHECK_MS = 10;
// A WHATWG WebSocket cannot pause reads, so a local socket this far behind ends the stream.
const TCP_MAX_QUEUED = 256 * 1024 * 1024;

const decodeServerFrame = Schema.decodeUnknownOption(Schema.fromJsonString(AdbBridgeServerFrame));

export const openAdbBridgeConnection = (
  url: string,
  localPort: number,
  transport: AdbBridgeTransport,
  callbacks: AdbBridgeConnectionCallbacks,
): AdbBridgeConnection => {
  let stream = initialBridgeStream;
  let tcp: BridgeTcpSocket | undefined;
  let cancelDrainCheck: (() => void) | undefined;
  let finished = false;

  const stopDrainCheck = () => {
    cancelDrainCheck?.();
    cancelDrainCheck = undefined;
  };

  const destroyTcp = () => {
    stopDrainCheck();
    const current = tcp;
    tcp = undefined;
    current?.destroy();
  };

  const waitForDrain = () => {
    cancelDrainCheck = transport.setTimer(() => {
      cancelDrainCheck = undefined;
      if (tcp === undefined) return;
      if (ws.bufferedAmount() <= WEBSOCKET_LOW_WATER) tcp.resume();
      else waitForDrain();
    }, WEBSOCKET_DRAIN_CHECK_MS);
  };

  const dispatch = (input: BridgeStreamInput) => {
    const [next, effects] = stepBridgeStream(stream, input);
    stream = next;
    for (const effect of effects) {
      switch (effect.type) {
        case "connect-tcp":
          connect(effect.id);
          break;
        case "destroy-tcp":
          destroyTcp();
          break;
        case "send":
          ws.send(JSON.stringify({ type: effect.frame } satisfies AdbBridgeClientFrame));
          break;
      }
    }
  };

  const connect = (id: number) => {
    let ended = false;
    const socket = transport.connectTcp(localPort, {
      onData: (data) => {
        if (stream.phase !== "open" || stream.id !== id) return;
        ws.send(data);
        if (cancelDrainCheck === undefined && ws.bufferedAmount() > WEBSOCKET_HIGH_WATER) {
          socket.pause();
          waitForDrain();
        }
      },
      onEnded: () => {
        if (ended) return;
        ended = true;
        dispatch({ type: "tcp-ended", id });
      },
    });
    if (!ended && stream.phase === "open" && stream.id === id) tcp = socket;
    else socket.destroy();
  };

  const finish = () => {
    if (finished) return false;
    finished = true;
    destroyTcp();
    return true;
  };

  const ws = transport.openWebSocket(url, {
    onMessage: (data) => {
      if (finished) return;
      if (typeof data !== "string") {
        // Bytes outside an open stream are stale and dropped.
        if (stream.phase !== "open" || tcp === undefined) return;
        tcp.write(data);
        if (tcp.writableLength() > TCP_MAX_QUEUED) dispatch({ type: "tcp-ended", id: stream.id });
        return;
      }
      const frame = decodeServerFrame(data);
      if (Option.isNone(frame)) return;
      switch (frame.value.type) {
        case "open":
          dispatch({ type: "server-open" });
          break;
        case "close":
          dispatch({ type: "server-close" });
          break;
        case "closed":
          dispatch({ type: "server-closed" });
          break;
        case "status":
          callbacks.onStatus(frame.value);
          break;
      }
    },
    onClose: (detail) => {
      if (finish()) callbacks.onDropped(detail);
    },
  });

  return {
    close: () => {
      if (finish()) ws.close();
    },
  };
};
