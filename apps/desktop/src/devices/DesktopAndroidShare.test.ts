import type {
  DesktopAndroidShare as AndroidShare,
  DesktopAndroidShareState,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { type AdbRunner, make, reduceAndroidShare } from "./DesktopAndroidShare.ts";
import { type FakeWebSocket, makeFakeTransport, sendServerFrame } from "./fakeBridgeTransport.ts";

const PHONE = "R58M12345ABC";
const DEVICES_WITH_PHONE = `List of devices attached\n${PHONE} device usb:1-1 model:SM_G973F\n`;

const makeHarness = Effect.fn("makeHarness")(function* (
  options: { readonly failTcpip?: string } = {},
) {
  const calls: Array<string> = [];
  const adbd = { tcpPort: "", devices: DEVICES_WITH_PHONE };
  const runAdb: AdbRunner = (_path, args) =>
    Effect.suspend(() => {
      const command = args.join(" ");
      calls.push(command);
      const ok = (stdout = "") => Effect.succeed({ stdout, stderr: "", exitCode: 0 });
      if (command === "devices -l") return ok(adbd.devices);
      if (command.endsWith("getprop service.adb.tcp.port")) return ok(`${adbd.tcpPort}\n`);
      if (command.endsWith("tcpip 5555")) {
        if (options.failTcpip) {
          return Effect.succeed({ stdout: "", stderr: options.failTcpip, exitCode: 1 });
        }
        adbd.tcpPort = "5555";
        return ok("restarting in TCP mode port: 5555\n");
      }
      if (command.endsWith("forward tcp:0 tcp:5555")) return ok("41234\n");
      if (command.endsWith(" usb")) adbd.tcpPort = "";
      return ok();
    });
  const published = yield* Queue.unbounded<DesktopAndroidShareState>();
  const opened = yield* Queue.unbounded<FakeWebSocket>();
  const fake = makeFakeTransport({ onWebSocket: (ws) => Queue.offerUnsafe(opened, ws) });
  const service = yield* make({
    findAdb: Effect.succeedSome("/sdk/platform-tools/adb"),
    runAdb,
    transport: fake.transport,
    publish: (state) => Queue.offer(published, state).pipe(Effect.asVoid),
  });
  const awaitShare = Effect.fn("awaitShare")(function* (status: AndroidShare["status"]) {
    while (true) {
      const state = yield* Queue.take(published);
      const share = state.shares.find((entry) => entry.serial === PHONE);
      if (share?.status === status) return share;
    }
  });
  const shareNamed = { environmentId: "env-1", serial: PHONE };
  return { calls, adbd, fake, service, opened, awaitShare, shareNamed };
});

describe("reduceAndroidShare", () => {
  const share: AndroidShare = { environmentId: "env-1", serial: PHONE, status: "connecting" };

  it("maps environment statuses and keeps terminal reasons over a later drop", () => {
    const remote = (frame: Parameters<typeof reduceAndroidShare>[1] & { type: "remote-status" }) =>
      reduceAndroidShare(share, frame);
    assert.strictEqual(
      remote({ type: "remote-status", frame: { status: "unauthorized" } }).status,
      "waiting-for-phone",
    );
    assert.deepStrictEqual(
      remote({
        type: "remote-status",
        frame: { status: "ready", remoteSerial: "127.0.0.1:47001" },
      }),
      { ...share, status: "shared", remoteSerial: "127.0.0.1:47001" },
    );
    const shared = { ...share, status: "shared" as const, remoteSerial: "127.0.0.1:47001" };
    assert.deepStrictEqual(
      reduceAndroidShare(shared, {
        type: "remote-status",
        frame: { status: "offline", detail: "device offline" },
      }),
      { ...shared, detail: "device offline" },
    );

    const missing = remote({ type: "remote-status", frame: { status: "adb-missing" } });
    assert.strictEqual(missing.status, "remote-adb-missing");
    assert.strictEqual(reduceAndroidShare(missing, { type: "interrupted", detail: "x" }), missing);
    assert.deepStrictEqual(reduceAndroidShare(shared, { type: "interrupted", detail: "gone" }), {
      ...share,
      status: "interrupted",
      detail: "gone",
    });
  });
});

describe("DesktopAndroidShare", () => {
  it.effect("shares a phone, survives a dropped socket and unshares cleanly", () =>
    Effect.gen(function* () {
      const { calls, fake, service, opened, awaitShare, shareNamed } = yield* makeHarness();

      yield* service.start({ ...shareNamed, url: "ws://env/a" });
      const first = yield* Queue.take(opened);
      assert.strictEqual(first.url, "ws://env/a");
      assert.includeMembers(calls, [
        `-s ${PHONE} tcpip 5555`,
        `-s ${PHONE} wait-for-device`,
        `-s ${PHONE} forward tcp:0 tcp:5555`,
      ]);

      sendServerFrame(first, { type: "status", status: "unauthorized" });
      yield* awaitShare("waiting-for-phone");
      sendServerFrame(first, { type: "status", status: "ready", remoteSerial: "127.0.0.1:47001" });
      assert.strictEqual((yield* awaitShare("shared")).remoteSerial, "127.0.0.1:47001");

      sendServerFrame(first, { type: "open" });
      const tcp = fake.tcpSockets[0]!;
      assert.strictEqual(tcp.port, 41234);

      first.handlers.onClose("network went away");
      assert.strictEqual((yield* awaitShare("interrupted")).detail, "network went away");
      assert.isTrue(tcp.destroyed);
      assert.include(calls, `-s ${PHONE} forward --remove tcp:41234`);

      // The renderer restarts it with a fresh ticket; tcpip is already on, so adbd is not restarted.
      yield* service.start({ ...shareNamed, url: "ws://env/b" });
      const second = yield* Queue.take(opened);
      assert.strictEqual(second.url, "ws://env/b");
      assert.strictEqual(calls.filter((call) => call.endsWith("tcpip 5555")).length, 1);

      yield* service.stop(shareNamed);
      assert.isTrue(second.closed);
      assert.include(calls, `-s ${PHONE} usb`);
      assert.deepStrictEqual((yield* service.getState).shares, []);
    }),
  );

  it.effect("marks a share interrupted when the phone is unplugged", () =>
    Effect.gen(function* () {
      const { adbd, service, opened, awaitShare, shareNamed } = yield* makeHarness();
      yield* service.start({ ...shareNamed, url: "ws://env/a" });
      const ws = yield* Queue.take(opened);

      adbd.devices = "List of devices attached\n";
      yield* TestClock.adjust("3 seconds");
      assert.strictEqual((yield* awaitShare("interrupted")).detail, "The phone was unplugged.");
      assert.isTrue(ws.closed);
    }),
  );

  it.effect("fails with adb's reason when setup cannot finish", () =>
    Effect.gen(function* () {
      const { service, opened, awaitShare, shareNamed } = yield* makeHarness({
        failTcpip: "error: device unauthorized.",
      });
      yield* service.start({ ...shareNamed, url: "ws://env/a" });
      assert.strictEqual((yield* awaitShare("failed")).detail, "error: device unauthorized.");
      assert.strictEqual(yield* Queue.size(opened), 0);
    }),
  );
});
