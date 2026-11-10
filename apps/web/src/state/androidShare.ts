import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import {
  ADB_BRIDGE_ROUTE,
  type DesktopAndroidShare,
  type DesktopAndroidShareState,
  type DesktopBridge,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { isElectron } from "../env";
import {
  readLocalStorageValue,
  useLocalStorage,
  subscribeLocalStorageKey,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  androidShareKey,
  DesiredAndroidShares,
  isHaltedAndroidShareStatus,
  planAndroidShares,
  type AndroidShareKey,
} from "./androidShare.logic";
import { readEnvironment, readPrimaryEnvironmentId } from "./environments";
import { environmentCatalog } from "../connection/catalog";
import { environmentSession } from "./session";
import { environmentSummaries } from "./presentation";

// Which shares this computer wants is a per-client preference, so it lives in local storage.
const DESIRED_ANDROID_SHARES_STORAGE_KEY = "t3code:android-shares";

type AndroidShareBridge = DesktopBridge &
  Required<
    Pick<
      DesktopBridge,
      | "getAndroidShareState"
      | "setAndroidShareWatching"
      | "startAndroidShare"
      | "stopAndroidShare"
      | "onAndroidShareState"
    >
  >;

/** The desktop app's bridge, when this build can share phones. */
export function androidShareBridge(): AndroidShareBridge | null {
  const bridge = isElectron ? window.desktopBridge : undefined;
  return bridge?.getAndroidShareState &&
    bridge.setAndroidShareWatching &&
    bridge.startAndroidShare &&
    bridge.stopAndroidShare &&
    bridge.onAndroidShareState
    ? (bridge as AndroidShareBridge)
    : null;
}

const listeners = new Set<() => void>();
let bridgeState: DesktopAndroidShareState | null = null;
// Shares that never reached the desktop's main process, so they are not in `bridgeState`.
const startFailures = new Map<string, DesktopAndroidShare>();
let view: DesktopAndroidShareState | null = null;

function rebuildView() {
  view =
    bridgeState === null
      ? null
      : {
          ...bridgeState,
          shares: [
            ...bridgeState.shares,
            ...[...startFailures.values()].filter(
              (failure) =>
                !bridgeState?.shares.some(
                  (share) => androidShareKey(share) === androidShareKey(failure),
                ),
            ),
          ],
        };
  for (const listener of listeners) listener();
}

function publish(next: DesktopAndroidShareState) {
  bridgeState = next;
  rebuildView();
}

let watchers = 0;
let unsubscribeBridge: (() => void) | null = null;

/** The desktop only polls adb while something watches; every watcher shares one subscription. */
export function retainAndroidShareWatching(): () => void {
  const bridge = androidShareBridge();
  if (bridge === null) return () => {};
  if (watchers++ === 0) {
    unsubscribeBridge = bridge.onAndroidShareState(publish);
    void bridge
      .setAndroidShareWatching(true)
      .then(() => bridge.getAndroidShareState())
      .then(publish)
      .catch(() => {});
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--watchers > 0) return;
    unsubscribeBridge?.();
    unsubscribeBridge = null;
    void bridge.setAndroidShareWatching(false).catch(() => {});
  };
}

const subscribeShareState = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Phones on this computer and the shares in progress; null until the desktop has answered. */
export function useAndroidShareState(): DesktopAndroidShareState | null {
  return useSyncExternalStore(subscribeShareState, () => view);
}

const NO_SHARES: DesiredAndroidShares = [];

/** The shares the user has switched on, running or not. */
export function useDesiredAndroidShares(): DesiredAndroidShares {
  return useLocalStorage(DESIRED_ANDROID_SHARES_STORAGE_KEY, NO_SHARES, DesiredAndroidShares)[0];
}

const readDesired = () =>
  readLocalStorageValue(DESIRED_ANDROID_SHARES_STORAGE_KEY, [], DesiredAndroidShares);
const writeDesired = (next: DesiredAndroidShares) =>
  writeLocalStorageValue(DESIRED_ANDROID_SHARES_STORAGE_KEY, next, [], DesiredAndroidShares);

// Only the toggle clears these; see planAndroidShares.
const halted = new Set<string>();
const restarts = new Map<string, number>();
const inFlight = new Set<string>();
const stopping = new Set<string>();
let replan: () => void = () => {};

/** The switch in Settings: share this phone with the environment, or stop. */
export function setAndroidShareEnabled(share: AndroidShareKey, enabled: boolean): void {
  const key = androidShareKey(share);
  halted.delete(key);
  restarts.delete(key);
  startFailures.delete(key);
  const others = readDesired().filter((entry) => androidShareKey(entry) !== key);
  if (enabled) {
    writeDesired([...others, { environmentId: share.environmentId, serial: share.serial }]);
  } else {
    writeDesired(others);
    void androidShareBridge()
      ?.stopAndroidShare(share)
      .catch(() => {});
  }
  rebuildView();
  replan();
}

const adbBridgeAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: ADB_BRIDGE_ROUTE });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`adb-bridge-access:${environmentId}`)),
);

/** A one-use ticket for one socket, so every start mints its own. */
function mintAdbBridgeAccess(environmentId: EnvironmentId): Promise<DeviceHubAccess | null> {
  const atom = adbBridgeAccessAtom(environmentId);
  appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}

// This computer's own environment carries its name; the phone's owner is who people see it as.
const computerLabel = () => {
  const primaryId = readPrimaryEnvironmentId();
  return (primaryId && readEnvironment(primaryId)?.label.trim().slice(0, 128)) || "Desktop";
};

async function startShare(bridge: AndroidShareBridge, share: AndroidShareKey) {
  const environmentId = share.environmentId as EnvironmentId;
  const access = await mintAdbBridgeAccess(environmentId);
  if (access === null) throw new Error("Could not get access to the environment.");
  const params = new URLSearchParams({ serial: share.serial, label: computerLabel() });
  await bridge.startAndroidShare({
    environmentId: share.environmentId,
    serial: share.serial,
    url: withDeviceHubQuery(`${access.wsBase}?${params.toString()}`, access),
  });
}

/**
 * Keeps the shares the user switched on running: starts them once the phone and the environment
 * are both there, and again after an interruption. The main process owns the sockets but cannot
 * mint tickets, so restarts have to come from here.
 */
export function startAndroidShareCoordinator(): void {
  const bridge = androidShareBridge();
  if (bridge === null) return;
  let release: (() => void) | null = null;

  replan = () => {
    const desired = readDesired();
    if (desired.length > 0 && release === null) release = retainAndroidShareWatching();
    if (desired.length === 0 && release !== null) {
      release();
      release = null;
    }
    if (bridgeState === null) return;
    for (const share of bridgeState.shares) {
      const key = androidShareKey(share);
      if (isHaltedAndroidShareStatus(share.status)) halted.add(key);
      if (share.status === "shared") restarts.delete(key);
    }
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    const plan = planAndroidShares({
      desired,
      devices: bridgeState.devices,
      shares: bridgeState.shares,
      connectedEnvironmentIds: new Set(
        appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom),
      ),
      knownEnvironmentIds: catalog.isReady ? new Set(catalog.entries.keys()) : null,
      inFlight,
      halted,
      restarts,
    });
    if (plan.drop.length > 0) {
      const dropped = new Set(plan.drop.map(androidShareKey));
      writeDesired(desired.filter((entry) => !dropped.has(androidShareKey(entry))));
    }
    for (const share of plan.stop) {
      const key = androidShareKey(share);
      if (stopping.has(key)) continue;
      stopping.add(key);
      void bridge
        .stopAndroidShare({ environmentId: share.environmentId, serial: share.serial })
        .catch(() => {})
        .finally(() => stopping.delete(key));
    }
    for (const share of plan.start) {
      const key = androidShareKey(share);
      inFlight.add(key);
      restarts.set(key, (restarts.get(key) ?? 0) + 1);
      void startShare(bridge, share)
        .catch((error: unknown) => {
          halted.add(key);
          startFailures.set(key, {
            environmentId: share.environmentId,
            serial: share.serial,
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
          });
          rebuildView();
        })
        .finally(() => {
          inFlight.delete(key);
          replan();
        });
    }
  };

  listeners.add(replan);
  subscribeLocalStorageKey(DESIRED_ANDROID_SHARES_STORAGE_KEY, replan);
  appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, replan);
  appAtomRegistry.subscribe(environmentSummaries.connectedEnvironmentIdsAtom, replan);
  replan();
}
