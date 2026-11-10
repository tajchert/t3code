import type { DesktopAndroidShare } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  androidShareKey,
  planAndroidShares,
  type AndroidSharePlanInput,
} from "./androidShare.logic";

const phone = { serial: "ABC", state: "device", name: "Pixel" };
const wanted = { environmentId: "env-1", serial: "ABC" };
const key = androidShareKey(wanted);

const plan = (overrides: Partial<AndroidSharePlanInput> = {}) =>
  planAndroidShares({
    desired: [wanted],
    devices: [phone],
    shares: [],
    connectedEnvironmentIds: new Set(["env-1"]),
    knownEnvironmentIds: new Set(["env-1"]),
    inFlight: new Set(),
    halted: new Set(),
    restarts: new Map(),
    ...overrides,
  });

const shareWith = (status: DesktopAndroidShare["status"]): DesktopAndroidShare => ({
  ...wanted,
  status,
});

describe("planAndroidShares", () => {
  it("starts a desired share whose phone and environment are both there", () => {
    expect(plan().start).toEqual([wanted]);
  });

  it("restarts an interrupted share", () => {
    expect(plan({ shares: [shareWith("interrupted")] }).start).toEqual([wanted]);
  });

  it.each(["connecting", "waiting-for-phone", "shared", "failed", "remote-adb-missing"] as const)(
    "leaves a %s share alone",
    (status) => {
      expect(plan({ shares: [shareWith(status)] }).start).toEqual([]);
    },
  );

  it("waits for the phone to be authorized and for the environment to connect", () => {
    expect(plan({ devices: [{ ...phone, state: "unauthorized" }] }).start).toEqual([]);
    expect(plan({ devices: [] }).start).toEqual([]);
    expect(plan({ connectedEnvironmentIds: new Set() }).start).toEqual([]);
  });

  it("does not start twice, retry a halted share, or restart one that keeps failing", () => {
    expect(plan({ inFlight: new Set([key]) }).start).toEqual([]);
    expect(plan({ halted: new Set([key]) }).start).toEqual([]);
    expect(plan({ restarts: new Map([[key, 3]]) }).start).toEqual([]);
    expect(plan({ restarts: new Map([[key, 2]]) }).start).toEqual([wanted]);
  });

  it("stops shares nobody asked for and drops those of removed environments", () => {
    expect(plan({ desired: [], shares: [shareWith("shared")] }).stop).toEqual([
      shareWith("shared"),
    ]);
    const removed = plan({
      shares: [shareWith("shared")],
      knownEnvironmentIds: new Set(["env-2"]),
    });
    expect(removed).toEqual({ start: [], stop: [shareWith("shared")], drop: [wanted] });
  });

  it("keeps desired shares while the environments have not loaded", () => {
    expect(plan({ knownEnvironmentIds: null })).toEqual({ start: [wanted], stop: [], drop: [] });
  });
});
