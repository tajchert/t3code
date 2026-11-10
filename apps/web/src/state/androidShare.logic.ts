import type { DesktopAndroidDevice, DesktopAndroidShare } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const DesiredAndroidShares = Schema.Array(
  Schema.Struct({ environmentId: Schema.String, serial: Schema.String }),
);
export type DesiredAndroidShares = typeof DesiredAndroidShares.Type;

export interface AndroidShareKey {
  readonly environmentId: string;
  readonly serial: string;
}

/** A share that keeps failing to come up is left alone after this many starts. */
const MAX_ANDROID_SHARE_RESTARTS = 3;

export const androidShareKey = (share: AndroidShareKey): string =>
  `${share.environmentId}\n${share.serial}`;

/** These ends will not change by retrying; only the user toggling the share again retries. */
export const isHaltedAndroidShareStatus = (status: DesktopAndroidShare["status"]): boolean =>
  status === "failed" || status === "remote-adb-missing";

export interface AndroidSharePlanInput {
  readonly desired: ReadonlyArray<AndroidShareKey>;
  readonly devices: ReadonlyArray<DesktopAndroidDevice>;
  readonly shares: ReadonlyArray<DesktopAndroidShare>;
  readonly connectedEnvironmentIds: ReadonlySet<string>;
  /** Every environment the app has; null until it has loaded, so nothing is pruned early. */
  readonly knownEnvironmentIds: ReadonlySet<string> | null;
  /** Keys with a start request in flight. */
  readonly inFlight: ReadonlySet<string>;
  /** Keys that failed for a reason a retry will not fix. */
  readonly halted: ReadonlySet<string>;
  /** Starts since the share last reached `shared`, by key. */
  readonly restarts: ReadonlyMap<string, number>;
}

export interface AndroidSharePlan {
  readonly start: ReadonlyArray<AndroidShareKey>;
  readonly stop: ReadonlyArray<AndroidShareKey>;
  /** Desired shares whose environment was removed. */
  readonly drop: ReadonlyArray<AndroidShareKey>;
}

export function planAndroidShares(input: AndroidSharePlanInput): AndroidSharePlan {
  const orphaned = (share: AndroidShareKey) =>
    input.knownEnvironmentIds !== null && !input.knownEnvironmentIds.has(share.environmentId);
  const drop = input.desired.filter(orphaned);
  const wanted = new Set(input.desired.filter((share) => !orphaned(share)).map(androidShareKey));
  const stop = input.shares.filter((share) => !wanted.has(androidShareKey(share)));
  const attached = new Set(
    input.devices.filter((device) => device.state === "device").map((device) => device.serial),
  );
  const current = new Map(input.shares.map((share) => [androidShareKey(share), share]));
  const start = input.desired.filter((share) => {
    const key = androidShareKey(share);
    if (!wanted.has(key) || input.inFlight.has(key) || input.halted.has(key)) return false;
    if (!attached.has(share.serial) || !input.connectedEnvironmentIds.has(share.environmentId)) {
      return false;
    }
    if ((input.restarts.get(key) ?? 0) >= MAX_ANDROID_SHARE_RESTARTS) return false;
    const status = current.get(key)?.status;
    return status === undefined || status === "interrupted";
  });
  return { start, stop, drop };
}
