import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * WebSocket route a desktop client opens once per shared Android device, with
 * `AdbBridgeQuery` and any `wsTicket` (`media`) in the query. Binary frames carry
 * adb bytes; text frames carry the JSON frames below. See docs/internals/devices.md.
 */
export const ADB_BRIDGE_ROUTE = "/api/device-bridge/adb";

export const AdbBridgeQuery = Schema.Struct({
  serial: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type AdbBridgeQuery = typeof AdbBridgeQuery.Type;

/** What the environment's adb server reports for the bridged device. */
export const AdbBridgeRemoteStatus = Schema.Literals([
  // The loopback listener is up and `adb connect` is running.
  "connecting",
  // The phone has not accepted this machine's adb key yet.
  "unauthorized",
  // `adb devices` lists the device; agents and the Device panel can use it.
  "ready",
  // adb reports the device offline, or `adb connect` failed; see `detail`.
  "offline",
  // No adb binary on the environment's machine. Nothing was started.
  "adb-missing",
]);
export type AdbBridgeRemoteStatus = typeof AdbBridgeRemoteStatus.Type;

/**
 * Only the environment sends `open`, and only while no stream is open. Either
 * side sends `close` when its TCP end finishes, then drops binary frames until
 * the peer answers `closed`. See docs/internals/devices.md.
 */
export const AdbBridgeServerFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("open") }),
  Schema.Struct({ type: Schema.Literal("close") }),
  Schema.Struct({ type: Schema.Literal("closed") }),
  Schema.Struct({
    type: Schema.Literal("status"),
    status: AdbBridgeRemoteStatus,
    /** The serial the device has on the environment, `127.0.0.1:<port>`. */
    remoteSerial: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
  }),
]);
export type AdbBridgeServerFrame = typeof AdbBridgeServerFrame.Type;

export const AdbBridgeClientFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("close") }),
  Schema.Struct({ type: Schema.Literal("closed") }),
]);
export type AdbBridgeClientFrame = typeof AdbBridgeClientFrame.Type;

/** A phone attached to the computer running the desktop app. */
export const DesktopAndroidDeviceSchema = Schema.Struct({
  serial: Schema.String,
  /** `adb devices` state: `device`, `unauthorized`, `offline`, ... */
  state: Schema.String,
  /** Model name from `adb devices -l`, or the serial when adb gives none. */
  name: Schema.String,
});
export type DesktopAndroidDevice = typeof DesktopAndroidDeviceSchema.Type;

export const DesktopAndroidShareStatusSchema = Schema.Literals([
  // tcpip, forward and the socket are being set up.
  "connecting",
  // The environment is waiting for the phone to accept its adb key.
  "waiting-for-phone",
  "shared",
  // The socket dropped or the phone was unplugged. The renderer restarts the
  // share with a fresh ticket once both are back.
  "interrupted",
  "remote-adb-missing",
  // Setting up failed for a reason retrying will not fix; see `detail`.
  "failed",
]);
export type DesktopAndroidShareStatus = typeof DesktopAndroidShareStatusSchema.Type;

export const DesktopAndroidShareSchema = Schema.Struct({
  environmentId: Schema.String,
  serial: Schema.String,
  status: DesktopAndroidShareStatusSchema,
  remoteSerial: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});
export type DesktopAndroidShare = typeof DesktopAndroidShareSchema.Type;

export const DesktopAndroidShareStateSchema = Schema.Struct({
  /** False when no adb binary was found on this computer. */
  adbAvailable: Schema.Boolean,
  devices: Schema.Array(DesktopAndroidDeviceSchema),
  shares: Schema.Array(DesktopAndroidShareSchema),
});
export type DesktopAndroidShareState = typeof DesktopAndroidShareStateSchema.Type;

export const DesktopAndroidShareStartInputSchema = Schema.Struct({
  environmentId: Schema.String,
  serial: Schema.String,
  /**
   * Full WebSocket URL of ADB_BRIDGE_ROUTE on the environment, with `serial`,
   * `label` and any `wsTicket` already in the query. The renderer mints the
   * ticket; the main process owns the socket.
   */
  url: Schema.String,
});
export type DesktopAndroidShareStartInput = typeof DesktopAndroidShareStartInputSchema.Type;

export const DesktopAndroidShareStopInputSchema = Schema.Struct({
  environmentId: Schema.String,
  serial: Schema.String,
});
export type DesktopAndroidShareStopInput = typeof DesktopAndroidShareStopInputSchema.Type;
