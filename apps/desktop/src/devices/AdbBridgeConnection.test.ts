import { assert, describe, it } from "@effect/vitest";

import { openAdbBridgeConnection } from "./AdbBridgeConnection.ts";
import { makeFakeTransport, sendServerFrame, textFrames } from "./fakeBridgeTransport.ts";

const bytes = (...values: Array<number>) => new Uint8Array(values);

const setup = () => {
  const fake = makeFakeTransport();
  const statuses: Array<unknown> = [];
  const drops: Array<string> = [];
  const connection = openAdbBridgeConnection(
    "ws://env/api/device-bridge/adb",
    41234,
    fake.transport,
    {
      onStatus: (frame) => statuses.push(frame),
      onDropped: (detail) => drops.push(detail),
    },
  );
  const ws = fake.webSockets[0]!;
  return { fake, ws, connection, statuses, drops };
};

describe("openAdbBridgeConnection", () => {
  it("pumps bytes both ways while a stream is open and answers the server's close", () => {
    const { fake, ws } = setup();
    sendServerFrame(ws, { type: "open" });
    const tcp = fake.tcpSockets[0]!;
    assert.strictEqual(tcp.port, 41234);

    ws.handlers.onMessage(bytes(1, 2));
    tcp.handlers.onData(bytes(3));
    assert.deepStrictEqual(tcp.written, [bytes(1, 2)]);
    assert.deepStrictEqual(ws.sent, [bytes(3)]);

    sendServerFrame(ws, { type: "close" });
    assert.isTrue(tcp.destroyed);
    assert.deepStrictEqual(textFrames(ws), [{ type: "closed" }]);

    // The destroyed socket's own close event belongs to a finished stream.
    tcp.handlers.onEnded();
    sendServerFrame(ws, { type: "open" });
    assert.strictEqual(fake.tcpSockets.length, 2);
    assert.deepStrictEqual(textFrames(ws), [{ type: "closed" }]);
  });

  it("sends close when the local socket ends and drops stale bytes until closed", () => {
    const { fake, ws } = setup();
    sendServerFrame(ws, { type: "open" });
    const tcp = fake.tcpSockets[0]!;
    tcp.handlers.onEnded();
    assert.deepStrictEqual(textFrames(ws), [{ type: "close" }]);
    assert.isTrue(tcp.destroyed);

    ws.handlers.onMessage(bytes(9));
    sendServerFrame(ws, { type: "open" });
    assert.deepStrictEqual(tcp.written, []);
    assert.strictEqual(fake.tcpSockets.length, 1);

    sendServerFrame(ws, { type: "closed" });
    sendServerFrame(ws, { type: "open" });
    assert.strictEqual(fake.tcpSockets.length, 2);
  });

  it("answers a crossing close while waiting for its own closed", () => {
    const { fake, ws } = setup();
    sendServerFrame(ws, { type: "open" });
    fake.tcpSockets[0]!.handlers.onEnded();
    sendServerFrame(ws, { type: "close" });
    assert.deepStrictEqual(textFrames(ws), [{ type: "close" }, { type: "closed" }]);

    sendServerFrame(ws, { type: "open" });
    assert.strictEqual(fake.tcpSockets.length, 1);
    sendServerFrame(ws, { type: "closed" });
    sendServerFrame(ws, { type: "open" });
    assert.strictEqual(fake.tcpSockets.length, 2);
  });

  it("pauses the local socket while the WebSocket is backed up", () => {
    const { fake, ws } = setup();
    sendServerFrame(ws, { type: "open" });
    const tcp = fake.tcpSockets[0]!;

    ws.buffered = 8 * 1024 * 1024;
    tcp.handlers.onData(bytes(1));
    assert.isTrue(tcp.paused);
    fake.fireTimers();
    assert.isTrue(tcp.paused);

    ws.buffered = 0;
    fake.fireTimers();
    assert.isFalse(tcp.paused);
  });

  it("forwards status frames and ignores malformed text", () => {
    const { ws, statuses } = setup();
    ws.handlers.onMessage("not json");
    ws.handlers.onMessage(JSON.stringify({ type: "status", status: "bogus" }));
    sendServerFrame(ws, { type: "status", status: "ready", remoteSerial: "127.0.0.1:47001" });
    assert.deepStrictEqual(statuses, [
      { type: "status", status: "ready", remoteSerial: "127.0.0.1:47001" },
    ]);
  });

  it("reports a dropped socket once and stays quiet after close()", () => {
    const dropped = setup();
    sendServerFrame(dropped.ws, { type: "open" });
    dropped.ws.handlers.onClose("gone");
    dropped.ws.handlers.onClose("gone again");
    assert.deepStrictEqual(dropped.drops, ["gone"]);
    assert.isTrue(dropped.fake.tcpSockets[0]!.destroyed);

    const closed = setup();
    closed.connection.close();
    closed.ws.handlers.onClose("closed by us");
    assert.isTrue(closed.ws.closed);
    assert.deepStrictEqual(closed.drops, []);
  });
});
