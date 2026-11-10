import type { DesktopAndroidDevice } from "@t3tools/contracts";

const EMULATOR_SERIAL = /^emulator-\d+$/u;

// Only USB phones can be shared: emulators and network (`host:port`, mDNS) devices are skipped.
const isShareableSerial = (serial: string) =>
  !EMULATOR_SERIAL.test(serial) && !serial.includes(":") && !serial.includes("._tcp");

/** Parses `adb devices -l` into the USB phones attached to this computer. */
export const parseAdbDevices = (stdout: string): ReadonlyArray<DesktopAndroidDevice> =>
  stdout.split(/\r?\n/u).flatMap((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("*") || trimmed.startsWith("List of devices")) {
      return [];
    }
    const [serial, ...rest] = trimmed.split(/\s+/u);
    if (serial === undefined || rest.length === 0 || !isShareableSerial(serial)) return [];
    const state = rest[0] === "no" && rest[1] === "permissions" ? "no permissions" : rest[0]!;
    const model = rest.find((token) => token.startsWith("model:"))?.slice("model:".length);
    return [{ serial, state, name: model ? model.replaceAll("_", " ") : serial }];
  });

export interface AdbCandidateInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
}

/** Where adb usually lives, most specific first, then every PATH entry. */
export const adbExecutableCandidates = ({
  env,
  platform,
  homeDirectory,
}: AdbCandidateInput): ReadonlyArray<string> => {
  const windows = platform === "win32";
  const separator = windows ? "\\" : "/";
  const executable = windows ? "adb.exe" : "adb";
  const join = (...parts: ReadonlyArray<string>) => parts.join(separator);
  const sdkRoots = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    platform === "darwin" ? join(homeDirectory, "Library", "Android", "sdk") : undefined,
    platform === "linux" ? join(homeDirectory, "Android", "Sdk") : undefined,
    windows && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Android", "Sdk") : undefined,
    platform === "darwin" ? "/opt/homebrew/share/android-commandlinetools" : undefined,
  ];
  const pathEntries = (env.PATH ?? env.Path ?? "").split(windows ? ";" : ":");
  const candidates = [
    ...sdkRoots.flatMap((root) => (root ? [join(root, "platform-tools", executable)] : [])),
    ...pathEntries.flatMap((entry) => (entry.trim() ? [join(entry.trim(), executable)] : [])),
  ];
  return [...new Set(candidates)];
};
