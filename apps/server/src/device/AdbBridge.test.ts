import { assert, expect, it } from "@effect/vitest";
import { type AdbBridgeServerFrame, LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";

import * as AdbBridge from "./AdbBridge.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * An in-memory client socket: `send` plays the desktop. Status frames come from
 * the adb watcher and interleave freely with the stream, so they queue apart.
 */
const makeClient = Effect.gen(function* () {
  const inbound = yield* Queue.unbounded<string | Uint8Array | number>();
  const outbound = yield* Queue.unbounded<string | Uint8Array>();
  const statuses = yield* Queue.unbounded<AdbBridgeServerFrame>();
  const route = (chunk: string | Uint8Array) => {
    if (typeof chunk === "string") {
      const frame = JSON.parse(chunk) as AdbBridgeServerFrame;
      if (frame.type === "status") return Queue.offer(statuses, frame).pipe(Effect.asVoid);
    }
    return Queue.offer(outbound, chunk).pipe(Effect.asVoid);
  };
  const socket = Socket.make({
    reader: Effect.succeed({
      pull: Queue.take(inbound).pipe(
        Effect.flatMap((frame) =>
          typeof frame === "number"
            ? Effect.fail(
                new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: frame }) }),
              )
            : Effect.succeed([frame] as const),
        ),
      ),
      upgrade: () => Effect.die("unsupported"),
    }),
    writer: Effect.succeed({
      write: (chunk) => (Socket.isCloseEvent(chunk) ? Effect.void : route(chunk)),
      writeAll: (chunks) => Effect.forEach(chunks, route, { discard: true }),
    }),
  });
  const control = Effect.gen(function* () {
    const frame = yield* Queue.take(outbound);
    assert(typeof frame === "string", "expected a control frame");
    return JSON.parse(frame) as AdbBridgeServerFrame;
  });
  const bytes = Effect.fnUntraced(function* (length: number) {
    let text = "";
    while (text.length < length) {
      const frame = yield* Queue.take(outbound);
      assert(typeof frame !== "string", `expected bytes, got ${String(frame)}`);
      text += decoder.decode(frame);
    }
    return text;
  });
  return {
    socket,
    status: Queue.take(statuses),
    control,
    bytes,
    send: (frame: { readonly type: "close" | "closed" } | string) =>
      Queue.offer(
        inbound,
        typeof frame === "string" ? encoder.encode(frame) : JSON.stringify(frame),
      ),
    // 1000 is a clean close, 1006 a dropped connection.
    end: (code: number) => Queue.offer(inbound, code),
  };
});

/** Plays this machine's adb: `connect` dials the listener like the adb server would. */
const makeAdb = Effect.fnUntraced(function* (connectedState = "device") {
  const calls: Array<ReadonlyArray<string>> = [];
  const states = new Map<string, string>();
  const remotes = yield* Queue.unbounded<NodeNet.Socket>();
  const run: AdbBridge.AdbRun = (args) =>
    Effect.gen(function* () {
      calls.push(args);
      const [command, serial = ""] = args;
      if (command === "connect") {
        const remote = yield* dial(Number(serial.split(":")[1]));
        yield* Queue.offer(remotes, remote);
        if (!states.has(serial)) states.set(serial, connectedState);
        return { code: 0, stdout: `connected to ${serial}\n`, stderr: "" };
      }
      if (command === "devices") {
        const lines = [...states].map(([name, state]) => `${name}\t${state}`);
        return { code: 0, stdout: ["List of devices attached", ...lines].join("\n"), stderr: "" };
      }
      if (command === "disconnect") states.delete(serial);
      return { code: 0, stdout: "", stderr: "" };
    }).pipe(Effect.orDie);
  return { run, calls, states, remotes };
});

const dial = (port: number) =>
  Effect.callback<NodeNet.Socket, Error>((resume) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.once("connect", () => resume(Effect.succeed(socket)));
    socket.once("error", (error) => resume(Effect.fail(error)));
  });

const received = (socket: NodeNet.Socket, length: number) =>
  Effect.callback<string>((resume) => {
    let text = "";
    const onData = (data: Buffer) => {
      text += data.toString();
      if (text.length < length) return;
      socket.off("data", onData);
      resume(Effect.succeed(text));
    };
    socket.on("data", onData);
  });

const closed = (socket: NodeNet.Socket) =>
  Effect.callback<void>((resume) => {
    if (socket.closed) return resume(Effect.void);
    socket.resume();
    socket.once("close", () => resume(Effect.void));
  });

const portOf = (frame: AdbBridgeServerFrame) => {
  assert(frame.type === "status" && frame.remoteSerial !== undefined);
  return Number(frame.remoteSerial.split(":")[1]);
};

const query = { serial: "R5CT1234", label: "Work laptop" };

it.effect("pipes bytes both ways and disconnects adb when the client closes", () =>
  Effect.gen(function* () {
    const adb = yield* makeAdb();
    const bridge = yield* AdbBridge.make(Effect.succeed(adb.run));
    const client = yield* makeClient;
    const serving = yield* bridge.serve(client.socket, query).pipe(Effect.forkChild);

    const status = yield* client.status;
    expect(status).toMatchObject({ type: "status", status: "connecting" });
    const remoteSerial = `127.0.0.1:${portOf(status)}`;
    expect(yield* client.control).toEqual({ type: "open" });
    // The fake adb dialed the listener from inside `adb connect`, so it was already up.
    expect(adb.calls[0]).toEqual(["connect", remoteSerial]);
    const remote = yield* Queue.take(adb.remotes);

    remote.write("CNXN-1");
    remote.write("CNXN-2");
    expect(yield* client.bytes(12)).toBe("CNXN-1CNXN-2");
    const echoed = received(remote, 10);
    yield* client.send("AUTH-1");
    yield* client.send("AUTH");
    expect(yield* echoed).toBe("AUTH-1AUTH");
    expect(yield* bridge.bridged).toEqual(new Map([[remoteSerial, query.label]]));

    yield* client.end(1000);
    yield* Fiber.join(serving);
    yield* closed(remote);
    expect(adb.calls.at(-1)).toEqual(["disconnect", remoteSerial]);
    expect(yield* bridge.bridged).toEqual(new Map());
    const refused = yield* dial(portOf(status)).pipe(Effect.flip);
    expect(refused.message).toContain("ECONNREFUSED");
  }),
);

it.effect("disconnects adb and closes the stream when the client socket drops", () =>
  Effect.gen(function* () {
    const adb = yield* makeAdb();
    const bridge = yield* AdbBridge.make(Effect.succeed(adb.run));
    const client = yield* makeClient;
    const serving = yield* bridge.serve(client.socket, query).pipe(Effect.forkChild);
    const port = portOf(yield* client.status);
    expect(yield* client.control).toEqual({ type: "open" });
    const remote = yield* Queue.take(adb.remotes);

    yield* client.end(1006);
    yield* Fiber.join(serving);
    yield* closed(remote);
    expect(adb.calls.at(-1)).toEqual(["disconnect", `127.0.0.1:${port}`]);
  }),
);

it.effect("keeps a serial's port across reconnects and skips an occupied one", () =>
  Effect.gen(function* () {
    const adb = yield* makeAdb();
    const bridge = yield* AdbBridge.make(Effect.succeed(adb.run));
    const serial = "occupied-serial";
    const preferred = AdbBridge.preferredPort(serial);
    const blocker = yield* Effect.acquireRelease(
      Effect.callback<NodeNet.Server>((resume) => {
        const server = NodeNet.createServer();
        server.listen(preferred, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
    );

    const bridgeOnce = Effect.gen(function* () {
      const client = yield* makeClient;
      const serving = yield* bridge
        .serve(client.socket, { serial, label: "Laptop" })
        .pipe(Effect.forkChild);
      const port = portOf(yield* client.status);
      yield* client.control;
      yield* client.end(1000);
      yield* Fiber.join(serving);
      return port;
    });

    const first = yield* bridgeOnce;
    expect(first).not.toBe(preferred);
    expect(first).toBe(preferred === 47_999 ? 47_000 : preferred + 1);
    // The preferred port is free again, but the serial keeps the one adb already knows.
    yield* Effect.callback<void>((resume) => void blocker.close(() => resume(Effect.void)));
    expect(yield* bridgeOnce).toBe(first);
  }),
);

it.effect("replaces an earlier bridge for the same serial without leaking its listener", () =>
  Effect.gen(function* () {
    const adb = yield* makeAdb();
    const bridge = yield* AdbBridge.make(Effect.succeed(adb.run));
    const first = yield* makeClient;
    const firstServing = yield* bridge.serve(first.socket, query).pipe(Effect.forkChild);
    const port = portOf(yield* first.status);
    yield* first.control;
    const firstRemote = yield* Queue.take(adb.remotes);

    const second = yield* makeClient;
    const secondServing = yield* bridge.serve(second.socket, query).pipe(Effect.forkChild);
    yield* Fiber.join(firstServing);
    yield* closed(firstRemote);
    expect(adb.calls).toContainEqual(["disconnect", `127.0.0.1:${port}`]);

    // Binding the same port again proves the first listener closed.
    expect(portOf(yield* second.status)).toBe(port);
    expect(yield* second.control).toEqual({ type: "open" });
    expect(yield* bridge.bridged).toEqual(new Map([[`127.0.0.1:${port}`, query.label]]));
    yield* second.end(1000);
    yield* Fiber.join(secondServing);
  }),
);

it.effect("drops binary frames until the close handshake completes", () =>
  Effect.gen(function* () {
    const adb = yield* makeAdb();
    const bridge = yield* AdbBridge.make(Effect.succeed(adb.run));
    const client = yield* makeClient;
    const serving = yield* bridge.serve(client.socket, query).pipe(Effect.forkChild);
    const port = portOf(yield* client.status);
    expect(yield* client.control).toEqual({ type: "open" });
    const remote = yield* Queue.take(adb.remotes);

    // The remote adb server ends its TCP stream: the environment closes first.
    remote.end();
    expect(yield* client.control).toEqual({ type: "close" });
    yield* client.send("stale");
    // A connection while the old stream is closing is refused.
    const early = yield* dial(port);
    yield* closed(early);
    yield* client.send({ type: "closed" });

    const next = yield* dial(port);
    expect(yield* client.control).toEqual({ type: "open" });
    const fresh = received(next, 5);
    yield* client.send("fresh");
    expect(yield* fresh).toBe("fresh");

    // The client's TCP end finishes: the environment closes its end and answers.
    yield* client.send({ type: "close" });
    expect(yield* client.control).toEqual({ type: "closed" });
    yield* closed(next);

    yield* client.end(1000);
    yield* Fiber.join(serving);
  }),
);

it.effect("reports authorization and readiness, and signals device list changes", () =>
  Effect.gen(function* () {
    const adb = yield* makeAdb("unauthorized");
    const bridge = yield* AdbBridge.make(Effect.succeed(adb.run));
    const changes = yield* bridge.subscribeChanges;
    const client = yield* makeClient;
    const serving = yield* bridge.serve(client.socket, query).pipe(Effect.forkChild);

    const remoteSerial = `127.0.0.1:${portOf(yield* client.status)}`;
    expect(yield* client.control).toEqual({ type: "open" });
    expect(yield* client.status).toEqual({ type: "status", status: "unauthorized", remoteSerial });

    adb.states.set(remoteSerial, "device");
    yield* TestClock.adjust("1 second");
    expect(yield* client.status).toEqual({ type: "status", status: "ready", remoteSerial });
    yield* PubSub.take(changes);

    const marked = yield* AdbBridge.markShared(Option.some(bridge), LOCAL_DEVICE_HOST_ID, [
      {
        hostId: LOCAL_DEVICE_HOST_ID,
        id: remoteSerial,
        name: "Pixel",
        version: "15",
        platform: "android",
        booted: true,
        physical: true,
      },
    ]);
    expect(marked[0]?.sharedFrom).toBe(query.label);

    yield* client.end(1000);
    yield* Fiber.join(serving);
    yield* PubSub.take(changes);
  }),
);

it.effect("starts nothing when this machine has no adb", () =>
  Effect.gen(function* () {
    const bridge = yield* AdbBridge.make(Effect.succeed(null));
    const client = yield* makeClient;
    const serving = yield* bridge.serve(client.socket, query).pipe(Effect.forkChild);
    expect(yield* client.status).toEqual({ type: "status", status: "adb-missing" });
    expect(yield* bridge.bridged).toEqual(new Map());
    yield* client.end(1000);
    yield* Fiber.join(serving);
  }),
);
