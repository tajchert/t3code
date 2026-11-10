import { afterEach, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AdbBridge from "./AdbBridge.ts";
import * as AdbBridgeRoute from "./AdbBridgeRoute.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (scopes: ReadonlyArray<AuthEnvironmentScope>) => {
  const served: string[] = [];
  const { handler, dispose } = HttpRouter.toWebHandler(
    AdbBridgeRoute.layer.pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("test"),
              subject: "test",
              method: "bearer-access-token",
              scopes,
            }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(AdbBridge.AdbBridge, {
          serve: (_client, query) => Effect.sync(() => void served.push(query.serial)),
        } as AdbBridge.AdbBridge["Service"]),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, served };
};

const url = "http://t3.test/api/device-bridge/adb?serial=R5CT1234&label=Laptop&wsTicket=t";

it("refuses a session without operate scope", async () => {
  const { handler, served } = fixture([AuthOrchestrationReadScope]);
  const response = await handler(new Request(url, { headers: { upgrade: "websocket" } }));
  expect(response.status).toBe(403);
  expect(served).toEqual([]);
});

it("refuses a bridge without a serial before upgrading", async () => {
  const { handler, served } = fixture([AuthOrchestrationOperateScope]);
  const response = await handler(
    new Request("http://t3.test/api/device-bridge/adb?label=Laptop", {
      headers: { upgrade: "websocket" },
    }),
  );
  expect(response.status).toBe(400);
  expect(served).toEqual([]);
});
