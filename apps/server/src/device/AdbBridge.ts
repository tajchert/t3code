import {
  type AdbBridgeQuery,
  AdbBridgeClientFrame,
  type AdbBridgeRemoteStatus,
  type AdbBridgeServerFrame,
  type DeviceError,
  type DeviceHostId,
  type DeviceSummary,
  LOCAL_DEVICE_HOST_ID,
} from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProcessRunner from "../processRunner.ts";
import { androidSdk } from "./LocalDeviceHost.ts";

/** Runs one adb command to completion. */
export type AdbRun = (
  args: ReadonlyArray<string>,
) => Effect.Effect<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

const PORT_START = 47_000;
const PORT_COUNT = 1_000;
const WAITING_POLL = Duration.seconds(1);
const READY_POLL = Duration.seconds(5);

/** The port a laptop serial asks for first; stable across server restarts. */
export const preferredPort = (serial: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < serial.length; index++) {
    hash = Math.imul(hash ^ serial.charCodeAt(index), 0x01000193) >>> 0;
  }
  return PORT_START + (hash % PORT_COUNT);
};

const decodeClientFrame = Schema.decodeUnknownOption(Schema.fromJsonString(AdbBridgeClientFrame));

const adbDeviceState = (devicesOutput: string, serial: string) => {
  for (const line of devicesOutput.split(/\r?\n/)) {
    const [name, state] = line.trim().split(/\s+/);
    if (name === serial && state) return state;
  }
  return undefined;
};

const statusFromAdbState = (
  state: string,
): { readonly status: AdbBridgeRemoteStatus; readonly detail?: string } => {
  switch (state) {
    case "device":
      return { status: "ready" };
    case "unauthorized":
    case "authorizing":
      return { status: "unauthorized" };
    case "connecting":
      return { status: "connecting" };
    case "offline":
      return { status: "offline", detail: "adb reports the device offline." };
    default:
      return { status: "offline", detail: `adb reports the device as ${state}.` };
  }
};

const connectSucceeded = (output: string) => /^(already )?connected to /m.test(output);

type StreamState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "open"; readonly writer: Socket.Writer; readonly finish: Effect.Effect<void> }
  // This side sent `close` and drops binary frames until the client answers `closed`.
  | { readonly _tag: "closing" };

interface BridgeEntry {
  readonly label: string;
  remoteSerial: string | undefined;
  readonly stop: Effect.Effect<void>;
}

export class AdbBridge extends Context.Service<
  AdbBridge,
  {
    /**
     * Bridges one desktop client socket until it closes or a newer bridge for
     * the same serial replaces it. `drain` waits while the client socket's
     * outgoing buffer is full.
     */
    readonly serve: (
      client: Socket.Socket,
      query: AdbBridgeQuery,
      options?: { readonly drain?: Effect.Effect<void> },
    ) => Effect.Effect<void>;
    /** Bridged devices: their serial on this machine's adb, to the sharing computer's label. */
    readonly bridged: Effect.Effect<ReadonlyMap<string, string>>;
    /** Emits when a bridged device becomes ready or goes away. */
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
  }
>()("t3/device/AdbBridge") {}

export const make = Effect.fn("AdbBridge.make")(function* (
  resolveAdb: Effect.Effect<AdbRun | null>,
) {
  const bridges = new Map<string, BridgeEntry>();
  const ports = new Map<string, number>();
  const registry = yield* Semaphore.make(1);
  const changed = yield* PubSub.unbounded<void>();
  const signalChange = PubSub.publish(changed, undefined).pipe(Effect.asVoid);

  const bindListener = Effect.fn("AdbBridge.bindListener")(function* (serial: string) {
    const first = ports.get(serial) ?? preferredPort(serial);
    const reserved = new Set(
      [...ports].filter(([other]) => other !== serial).map(([, port]) => port),
    );
    for (let offset = 0; offset < PORT_COUNT; offset++) {
      const port = PORT_START + ((first - PORT_START + offset) % PORT_COUNT);
      if (reserved.has(port)) continue;
      const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port }).pipe(Effect.option);
      if (Option.isSome(server)) {
        ports.set(serial, port);
        return { server: server.value, port };
      }
    }
    return null;
  });

  const run = Effect.fn("AdbBridge.run")(function* (
    client: Socket.Socket,
    query: AdbBridgeQuery,
    entry: BridgeEntry,
    drain: Effect.Effect<void>,
  ) {
    const { pull: pullClient } = yield* client.reader;
    const clientWriter = yield* client.writer;
    const send = (frame: AdbBridgeServerFrame) =>
      clientWriter.write(JSON.stringify(frame)).pipe(Effect.ignore);
    let stream: StreamState = { _tag: "idle" };

    const onControl = Effect.fnUntraced(function* (text: string) {
      const frame = decodeClientFrame(text);
      if (Option.isNone(frame)) return;
      if (frame.value.type === "closed") {
        if (stream._tag === "closing") stream = { _tag: "idle" };
        return;
      }
      if (stream._tag === "open") {
        const finish = stream.finish;
        stream = { _tag: "idle" };
        yield* finish;
      }
      yield* send({ type: "closed" });
    });

    // Client frames: control text, or bytes for the open TCP stream.
    const clientLoop = Effect.forever(
      Effect.gen(function* () {
        for (const frame of yield* pullClient) {
          if (typeof frame === "string") yield* onControl(frame);
          else if (stream._tag === "open") yield* stream.writer.write(frame).pipe(Effect.ignore);
        }
      }),
    ).pipe(Effect.ignore);

    const adb = yield* resolveAdb;
    if (!adb) {
      yield* send({ type: "status", status: "adb-missing" });
      return yield* clientLoop;
    }

    const bound = yield* bindListener(query.serial);
    if (!bound) {
      yield* send({
        type: "status",
        status: "offline",
        detail: `No free loopback port between ${PORT_START} and ${PORT_START + PORT_COUNT - 1}.`,
      });
      return yield* clientLoop;
    }
    const remoteSerial = `127.0.0.1:${bound.port}`;

    // One TCP stream at a time: the remote adb server's connection to the listener.
    const onConnection = (connection: Socket.Socket) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (stream._tag !== "idle") {
            // adb retries; the next attempt lands once the open stream has closed.
            const socket = yield* Effect.serviceOption(NodeSocket.NetSocket);
            if (Option.isSome(socket)) socket.value.destroy();
            return;
          }
          const tcpWriter = yield* connection.writer;
          const { pull } = yield* connection.reader;
          const finished = yield* Deferred.make<void>();
          const current: StreamState = {
            _tag: "open",
            writer: tcpWriter,
            finish: Deferred.succeed(finished, undefined).pipe(Effect.asVoid),
          };
          stream = current;
          yield* send({ type: "open" });
          const pump = Effect.forever(
            Effect.gen(function* () {
              const chunks = yield* pull;
              if (stream !== current) return;
              yield* clientWriter.writeAll(chunks);
              yield* drain;
            }),
          );
          yield* Effect.raceFirst(pump.pipe(Effect.ignore), Deferred.await(finished));
          if (stream === current) {
            stream = { _tag: "closing" };
            yield* send({ type: "close" });
          }
        }),
      );

    let last: { readonly status: AdbBridgeRemoteStatus; readonly detail?: string } | undefined;
    const setStatus = Effect.fnUntraced(function* (next: {
      readonly status: AdbBridgeRemoteStatus;
      readonly detail?: string;
    }) {
      if (last?.status === next.status && last.detail === next.detail) return next.status;
      const wasReady = last?.status === "ready";
      last = next;
      yield* send({ type: "status", ...next, remoteSerial });
      if (wasReady !== (next.status === "ready")) yield* signalChange;
      return next.status;
    });

    const connect = Effect.gen(function* () {
      const result = yield* adb(["connect", remoteSerial]);
      const output = `${result.stdout}\n${result.stderr}`.trim();
      return yield* setStatus(
        result.code === 0 && connectSucceeded(output)
          ? { status: "connecting" }
          : { status: "offline", detail: output || `adb connect exited with ${result.code}.` },
      );
    });

    // adb reconnects devices it lists; one it dropped is connected again.
    const poll = Effect.gen(function* () {
      const listing = yield* adb(["devices"]);
      const state = adbDeviceState(listing.stdout, remoteSerial);
      return state === undefined ? yield* connect : yield* setStatus(statusFromAdbState(state));
    });

    const watch = Effect.gen(function* () {
      yield* connect;
      yield* poll.pipe(
        Effect.repeat({ schedule: Schedule.spaced(WAITING_POLL), until: (s) => s === "ready" }),
      );
      return yield* poll.pipe(Effect.repeat(Schedule.spaced(READY_POLL)));
    });

    entry.remoteSerial = remoteSerial;
    // Runs before the listener closes, which the socket server registered first.
    yield* Effect.addFinalizer(() =>
      adb(["disconnect", remoteSerial]).pipe(
        Effect.andThen(Effect.sync(() => (entry.remoteSerial = undefined))),
        Effect.andThen(signalChange),
      ),
    );
    yield* send({ type: "status", status: "connecting", remoteSerial });
    last = { status: "connecting" };
    yield* bound.server.run(onConnection).pipe(Effect.ignore, Effect.forkScoped);
    return yield* Effect.raceFirst(clientLoop, watch);
  });

  const serve: AdbBridge["Service"]["serve"] = Effect.fn("AdbBridge.serve")(
    function* (client, query, options) {
      const stopped = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const entry: BridgeEntry = {
        label: query.label,
        remoteSerial: undefined,
        stop: Deferred.succeed(stopped, undefined).pipe(Effect.andThen(Deferred.await(done))),
      };
      yield* registry.withPermit(
        Effect.gen(function* () {
          const previous = bridges.get(query.serial);
          if (previous) yield* previous.stop;
          bridges.set(query.serial, entry);
        }),
      );
      yield* Effect.scoped(run(client, query, entry, options?.drain ?? Effect.void)).pipe(
        Effect.ignore,
        Effect.raceFirst(Deferred.await(stopped)),
        Effect.ensuring(
          Effect.sync(() => {
            if (bridges.get(query.serial) === entry) bridges.delete(query.serial);
          }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
        ),
      );
    },
  );

  return AdbBridge.of({
    serve,
    bridged: Effect.sync(
      () =>
        new Map(
          [...bridges.values()].flatMap((entry) =>
            entry.remoteSerial ? [[entry.remoteSerial, entry.label] as const] : [],
          ),
        ),
    ),
    subscribeChanges: PubSub.subscribe(changed),
  });
});

export const layer = Layer.effect(
  AdbBridge,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const resolveAdb = androidSdk.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.map((sdk): AdbRun | null => {
        if (!sdk.root || !sdk.adb) return null;
        const command = path.join(
          sdk.root,
          "platform-tools",
          platform === "win32" ? "adb.exe" : "adb",
        );
        return (args) =>
          runner
            .run({
              command,
              args,
              timeout: Duration.seconds(20),
              timeoutBehavior: "timedOutResult",
            })
            .pipe(
              Effect.map((result) => ({
                stdout: result.stdout,
                stderr: result.stderr,
                code: result.timedOut ? 124 : Number(result.code ?? 127),
              })),
              Effect.catch((cause) =>
                Effect.succeed({ stdout: "", stderr: String(cause), code: 127 }),
              ),
            );
      }),
    );
    return yield* make(resolveAdb);
  }),
);

/** Marks local devices another computer shares over a bridge. */
export const markShared = (
  bridge: Option.Option<AdbBridge["Service"]>,
  hostId: DeviceHostId,
  devices: Array<DeviceSummary>,
): Effect.Effect<Array<DeviceSummary>> =>
  Option.isNone(bridge) || hostId !== LOCAL_DEVICE_HOST_ID
    ? Effect.succeed(devices)
    : bridge.value.bridged.pipe(
        Effect.map((bridged) =>
          devices.map((device) => {
            const sharedFrom = bridged.get(device.id);
            return sharedFrom ? { ...device, sharedFrom } : device;
          }),
        ),
      );

/** Refreshes a running local device list whenever a bridged device appears or goes away. */
export const refreshDevicesOnChange = Effect.fn("AdbBridge.refreshDevicesOnChange")(
  function* (devices: {
    readonly currentReadiness: (hostId: DeviceHostId) => Effect.Effect<unknown>;
    readonly list: Effect.Effect<unknown, DeviceError>;
  }) {
    const bridge = yield* Effect.serviceOption(AdbBridge);
    if (Option.isNone(bridge)) return;
    yield* Stream.fromSubscription(yield* bridge.value.subscribeChanges).pipe(
      Stream.runForEach(() =>
        devices.currentReadiness(LOCAL_DEVICE_HOST_ID).pipe(
          Effect.flatMap((ready) => (ready ? devices.list : Effect.void)),
          Effect.ignore,
        ),
      ),
      Effect.forkScoped,
    );
  },
);
