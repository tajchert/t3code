import type {
  DesktopAndroidDevice,
  DesktopAndroidShare as AndroidShare,
  DesktopAndroidShareStartInput,
  DesktopAndroidShareState,
  DesktopAndroidShareStopInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "./androidShareChannels.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import {
  type AdbBridgeConnection,
  type AdbBridgeStatusFrame,
  type AdbBridgeTransport,
  openAdbBridgeConnection,
} from "./AdbBridgeConnection.ts";
import { adbExecutableCandidates, parseAdbDevices } from "./adbDevices.ts";
import { nodeBridgeTransport } from "./nodeBridgeTransport.ts";

export class AdbCommandError extends Schema.TaggedError<AdbCommandError>()("AdbCommandError", {
  args: Schema.Array(Schema.String),
  detail: Schema.String,
  timedOut: Schema.Boolean,
}) {
  override get message(): string {
    return `adb ${this.args.join(" ")} failed: ${this.detail}`;
  }
}

export interface AdbRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type AdbRunner = (
  adbPath: string,
  args: ReadonlyArray<string>,
  timeout: Duration.Input,
) => Effect.Effect<AdbRunResult, AdbCommandError>;

export type AndroidShareEvent =
  | { readonly type: "remote-status"; readonly frame: AdbBridgeStatusFrame }
  | { readonly type: "interrupted"; readonly detail: string }
  | { readonly type: "failed"; readonly detail: string };

const withOptional = (
  share: Pick<AndroidShare, "environmentId" | "serial" | "status">,
  remoteSerial: string | undefined,
  detail: string | undefined,
): AndroidShare => ({
  ...share,
  ...(remoteSerial === undefined ? {} : { remoteSerial }),
  ...(detail === undefined ? {} : { detail }),
});

export const reduceAndroidShare = (share: AndroidShare, event: AndroidShareEvent): AndroidShare => {
  const base = { environmentId: share.environmentId, serial: share.serial };
  switch (event.type) {
    case "remote-status": {
      const { status, remoteSerial, detail } = event.frame;
      switch (status) {
        case "connecting":
          return withOptional({ ...base, status: "connecting" }, undefined, detail);
        case "unauthorized":
          return withOptional({ ...base, status: "waiting-for-phone" }, undefined, detail);
        case "ready":
          return withOptional({ ...base, status: "shared" }, remoteSerial, detail);
        case "adb-missing":
          return withOptional({ ...base, status: "remote-adb-missing" }, undefined, detail);
        case "offline":
          return withOptional({ ...base, status: share.status }, share.remoteSerial, detail);
      }
      break;
    }
    case "interrupted":
      // The environment closes the socket after these; keep the reason it gave.
      if (share.status === "remote-adb-missing" || share.status === "failed") return share;
      return withOptional({ ...base, status: "interrupted" }, undefined, event.detail);
    case "failed":
      return withOptional({ ...base, status: "failed" }, undefined, event.detail);
  }
};

export class DesktopAndroidShare extends Context.Service<
  DesktopAndroidShare,
  {
    readonly getState: Effect.Effect<DesktopAndroidShareState>;
    readonly setWatching: (watching: boolean) => Effect.Effect<void>;
    readonly start: (input: DesktopAndroidShareStartInput) => Effect.Effect<void>;
    readonly stop: (input: DesktopAndroidShareStopInput) => Effect.Effect<void>;
    /** Unshares every phone. Bounded so quitting is never held up for long. */
    readonly stopAll: Effect.Effect<void>;
  }
>()("@t3tools/desktop/devices/DesktopAndroidShare") {}

export interface DesktopAndroidShareDependencies {
  readonly findAdb: Effect.Effect<Option.Option<string>>;
  readonly runAdb: AdbRunner;
  readonly transport: AdbBridgeTransport;
  readonly publish: (state: DesktopAndroidShareState) => Effect.Effect<void>;
}

interface ShareEntry {
  share: AndroidShare;
  /** Bumped by every start and stop so superseded setup work and socket callbacks do nothing. */
  generation: number;
  localPort: number | undefined;
  turnedOnTcpip: boolean;
  connection: AdbBridgeConnection | undefined;
  setup: Fiber.Fiber<void> | undefined;
  settingUp: boolean;
}

const ADB_TCP_PORT = "5555";
const POLL_INTERVAL = Duration.seconds(3);
const ADB_TIMEOUT = Duration.seconds(10);
const WAIT_FOR_DEVICE_TIMEOUT = Duration.seconds(30);
const STOP_ALL_TIMEOUT = Duration.seconds(3);

const shareKey = (input: { readonly environmentId: string; readonly serial: string }) =>
  `${input.environmentId}\u0000${input.serial}`;

const errorDetail = (error: AdbCommandError) => error.detail;

// The state is small, plain data; its JSON is a cheap change check for publishing.
const stateKey = (state: DesktopAndroidShareState) => JSON.stringify(state);

export const make = Effect.fn("DesktopAndroidShare.make")(function* (
  deps: DesktopAndroidShareDependencies,
) {
  const run = yield* FiberSet.makeRuntime<never>();
  const entries = new Map<string, ShareEntry>();
  let adbPath: string | undefined;
  let adbAvailable = false;
  let devices: ReadonlyArray<DesktopAndroidDevice> = [];
  let refreshed = false;
  let watching = false;
  let poller: Fiber.Fiber<unknown> | undefined;
  let lastPublished = "";

  const snapshot = (): DesktopAndroidShareState => ({
    adbAvailable,
    devices,
    shares: [...entries.values()].map((entry) => entry.share),
  });

  const emit = Effect.suspend(() => {
    const state = snapshot();
    const key = stateKey(state);
    if (key === lastPublished) return Effect.void;
    lastPublished = key;
    return deps.publish(state);
  });

  const resolveAdb = Effect.gen(function* () {
    if (adbPath === undefined) adbPath = Option.getOrUndefined(yield* deps.findAdb);
    adbAvailable = adbPath !== undefined;
    return Option.fromUndefinedOr(adbPath);
  });

  const adb = Effect.fn("DesktopAndroidShare.adb")(function* (
    args: ReadonlyArray<string>,
    timeout: Duration.Input = ADB_TIMEOUT,
  ) {
    const path = yield* resolveAdb;
    if (Option.isNone(path)) {
      return yield* new AdbCommandError({
        args,
        detail: "adb was not found on this computer.",
        timedOut: false,
      });
    }
    const result = yield* deps.runAdb(path.value, args, timeout);
    if (result.exitCode !== 0) {
      return yield* new AdbCommandError({
        args,
        detail: (result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`,
        timedOut: false,
      });
    }
    return result.stdout;
  });

  const removeForward = (serial: string, port: number) =>
    adb(["-s", serial, "forward", "--remove", `tcp:${port}`]).pipe(Effect.ignore);

  const dropConnection = (entry: ShareEntry) => {
    entry.connection?.close();
    entry.connection = undefined;
    const port = entry.localPort;
    entry.localPort = undefined;
    return port === undefined ? Effect.void : removeForward(entry.share.serial, port);
  };

  const interrupt = Effect.fn("DesktopAndroidShare.interrupt")(function* (
    entry: ShareEntry,
    detail: string,
  ) {
    entry.share = reduceAndroidShare(entry.share, { type: "interrupted", detail });
    yield* dropConnection(entry);
    yield* emit;
  });

  const refreshDevices = Effect.gen(function* () {
    const path = yield* resolveAdb;
    if (Option.isNone(path)) {
      devices = [];
    } else {
      const listed = yield* adb(["devices", "-l"]).pipe(Effect.option);
      devices = Option.match(listed, { onNone: () => [], onSome: parseAdbDevices });
    }
    refreshed = true;
    const online = new Set(devices.filter((d) => d.state === "device").map((d) => d.serial));
    for (const entry of entries.values()) {
      // Setup restarts adbd for tcpip, so the phone briefly disappears while it runs.
      if (entry.settingUp || online.has(entry.share.serial)) continue;
      if (entry.connection === undefined) continue;
      yield* interrupt(entry, "The phone was unplugged.");
    }
    yield* emit;
  }).pipe(Effect.withSpan("DesktopAndroidShare.refreshDevices"));

  const syncPolling = Effect.suspend(() => {
    const shouldPoll = watching || entries.size > 0;
    if (shouldPoll && poller === undefined) {
      poller = run(Effect.repeat(refreshDevices, Schedule.spaced(POLL_INTERVAL)));
      return Effect.void;
    }
    if (!shouldPoll && poller !== undefined) {
      const fiber = poller;
      poller = undefined;
      return Fiber.interrupt(fiber);
    }
    return Effect.void;
  });

  const applyEvent = (entry: ShareEntry, generation: number, event: AndroidShareEvent) => {
    if (entry.generation !== generation) return;
    entry.share = reduceAndroidShare(entry.share, event);
    run(emit);
  };

  const setup = (entry: ShareEntry, generation: number, url: string) => {
    const serial = entry.share.serial;
    const current = () => entry.generation === generation;
    return Effect.gen(function* () {
      const tcpPort = yield* adb(["-s", serial, "shell", "getprop", "service.adb.tcp.port"]);
      if (tcpPort.trim() !== ADB_TCP_PORT) {
        yield* adb(["-s", serial, "tcpip", ADB_TCP_PORT]);
        entry.turnedOnTcpip = true;
      }
      // adbd restarts after `tcpip`; the first forward can race the phone dropping off USB.
      const forwarded = yield* adb(["-s", serial, "wait-for-device"], WAIT_FOR_DEVICE_TIMEOUT).pipe(
        Effect.andThen(adb(["-s", serial, "forward", "tcp:0", `tcp:${ADB_TCP_PORT}`])),
        Effect.retry({
          while: (error) => !error.timedOut,
          schedule: Schedule.spaced(Duration.seconds(1)),
          times: 3,
        }),
      );
      const localPort = Number.parseInt(forwarded.trim(), 10);
      if (!Number.isInteger(localPort) || localPort <= 0) {
        return yield* new AdbCommandError({
          args: ["forward"],
          detail: `adb forward printed no port: ${forwarded.trim()}`,
          timedOut: false,
        });
      }
      if (!current()) return yield* removeForward(serial, localPort);
      entry.localPort = localPort;
      entry.connection = openAdbBridgeConnection(url, localPort, deps.transport, {
        onStatus: (frame) => applyEvent(entry, generation, { type: "remote-status", frame }),
        onDropped: (detail) => {
          if (entry.generation !== generation) return;
          entry.connection = undefined;
          run(interrupt(entry, detail));
        },
      });
    }).pipe(
      Effect.catch((error: AdbCommandError) =>
        Effect.gen(function* () {
          if (!current()) return;
          entry.share = error.timedOut
            ? reduceAndroidShare(entry.share, { type: "interrupted", detail: errorDetail(error) })
            : reduceAndroidShare(entry.share, { type: "failed", detail: errorDetail(error) });
          yield* emit;
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (current()) entry.settingUp = false;
        }),
      ),
      Effect.withSpan("DesktopAndroidShare.setup"),
    );
  };

  const teardown = Effect.fn("DesktopAndroidShare.teardown")(function* (entry: ShareEntry) {
    entry.generation += 1;
    const pending = entry.setup;
    entry.setup = undefined;
    entry.settingUp = false;
    if (pending !== undefined) yield* Fiber.interrupt(pending);
    yield* dropConnection(entry);
    const serial = entry.share.serial;
    const stillShared = [...entries.values()].some((other) => other.share.serial === serial);
    if (entry.turnedOnTcpip && !stillShared) {
      entry.turnedOnTcpip = false;
      yield* adb(["-s", serial, "usb"]).pipe(Effect.ignore);
    }
  });

  const stop = Effect.fn("DesktopAndroidShare.stop")(function* (
    input: DesktopAndroidShareStopInput,
  ) {
    const key = shareKey(input);
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    yield* teardown(entry);
    yield* emit;
    yield* syncPolling;
  });

  const stopAll = Effect.suspend(() => {
    const all = [...entries.values()];
    entries.clear();
    return Effect.forEach(all, teardown, { concurrency: "unbounded", discard: true });
  }).pipe(
    Effect.timeoutOption(STOP_ALL_TIMEOUT),
    Effect.asVoid,
    Effect.withSpan("DesktopAndroidShare.stopAll"),
  );

  yield* Effect.addFinalizer(() => stopAll);

  return DesktopAndroidShare.of({
    getState: Effect.suspend(() =>
      refreshed ? Effect.succeed(snapshot()) : refreshDevices.pipe(Effect.map(snapshot)),
    ),
    setWatching: Effect.fn("DesktopAndroidShare.setWatching")(function* (next) {
      watching = next;
      yield* syncPolling;
    }),
    start: Effect.fn("DesktopAndroidShare.start")(function* (input) {
      const key = shareKey(input);
      const existing = entries.get(key);
      if (existing !== undefined) {
        existing.generation += 1;
        const pending = existing.setup;
        existing.setup = undefined;
        if (pending !== undefined) yield* Fiber.interrupt(pending);
        yield* dropConnection(existing);
      }
      const entry: ShareEntry = existing ?? {
        share: { environmentId: input.environmentId, serial: input.serial, status: "connecting" },
        generation: 0,
        localPort: undefined,
        turnedOnTcpip: false,
        connection: undefined,
        setup: undefined,
        settingUp: false,
      };
      entry.share = {
        environmentId: input.environmentId,
        serial: input.serial,
        status: "connecting",
      };
      entries.set(key, entry);
      entry.settingUp = true;
      entry.setup = run(setup(entry, entry.generation, input.url));
      yield* emit;
      yield* syncPolling;
    }),
    stop,
    stopAll,
  });
});

const runAdbProcess = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): AdbRunner =>
  Effect.fn("DesktopAndroidShare.runAdb")(function* (adbPath, args, timeout) {
    const toError = (detail: string, timedOut = false) =>
      new AdbCommandError({ args: [...args], detail, timedOut });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(adbPath, [...args], { stdin: "ignore" }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, exitCode: Number(exitCode) };
      }),
    ).pipe(
      Effect.mapError((cause) => toError(String(cause))),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(toError("adb did not answer in time.", true)),
      }),
    );
  });

export const layer = Layer.effect(
  DesktopAndroidShare,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
    const electronWindow = yield* ElectronWindow.ElectronWindow;

    const findAdb = Effect.gen(function* () {
      // A Finder-launched app only has the user's PATH once shell discovery has finished.
      yield* shellEnvironment.awaitDiscovery.pipe(Effect.timeoutOption(Duration.seconds(6)));
      const candidates = adbExecutableCandidates({
        env: process.env,
        platform: environment.platform,
        homeDirectory: environment.homeDirectory,
      });
      return yield* Effect.findFirst(candidates, (candidate) =>
        fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)),
      );
    });

    return yield* make({
      findAdb,
      runAdb: runAdbProcess(spawner),
      transport: nodeBridgeTransport,
      publish: (state) => electronWindow.sendAll(IpcChannels.ANDROID_SHARE_STATE_CHANNEL, state),
    });
  }),
);
