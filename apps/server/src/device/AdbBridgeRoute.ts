import {
  ADB_BRIDGE_ROUTE,
  AdbBridgeQuery,
  AuthOrchestrationOperateScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";

import { authenticateMediaRequest } from "../auth/http.ts";
import { requestUrl } from "../requestUrl.ts";
import * as AdbBridge from "./AdbBridge.ts";

const decodeQuery = Schema.decodeUnknownOption(AdbBridgeQuery);

// Effect's WebSocket writer never waits for the peer, so an APK push would buffer
// in memory; wait on the upgraded connection's own `drain` instead.
const drainFor = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<void> => {
  // Absent outside Node's HTTP server, such as in web handler tests.
  const source: object = NodeHttpServerRequest.toIncomingMessage(request);
  const socket =
    "socket" in source ? NodeHttpServerRequest.toIncomingMessage(request).socket : null;
  if (!socket) return Effect.void;
  return Effect.callback<void>((resume) => {
    if (!socket.writableNeedDrain || socket.destroyed) return resume(Effect.void);
    const done = () => {
      socket.off("drain", done);
      socket.off("close", done);
      resume(Effect.void);
    };
    socket.on("drain", done);
    socket.on("close", done);
    return Effect.sync(() => {
      socket.off("drain", done);
      socket.off("close", done);
    });
  });
};

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
  const query = decodeQuery({
    serial: url.value.searchParams.get("serial"),
    label: url.value.searchParams.get("label"),
  });
  if (Option.isNone(query)) return HttpServerResponse.text("Bad Request", { status: 400 });
  if (request.headers.upgrade?.toLowerCase() !== "websocket") {
    return HttpServerResponse.text("Upgrade Required", { status: 426 });
  }
  const bridge = yield* AdbBridge.AdbBridge;
  const socket = yield* request.upgrade;
  yield* bridge.serve(socket, query.value, { drain: drainFor(request) });
  return HttpServerResponse.empty();
});

export const layer = HttpRouter.add("GET", ADB_BRIDGE_ROUTE, handler);
