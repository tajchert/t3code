import { assert, describe, it } from "@effect/vitest";

import { adbExecutableCandidates, parseAdbDevices } from "./adbDevices.ts";

describe("parseAdbDevices", () => {
  it("lists USB phones and skips emulators, network devices and daemon chatter", () => {
    const stdout = [
      "* daemon not running; starting now at tcp:5037",
      "* daemon started successfully",
      "List of devices attached",
      "R58M12345ABC           device usb:1-1 product:beyond1lteeea model:SM_G973F device:beyond1 transport_id:1",
      "0123456789ABCDEF       unauthorized usb:1-2 transport_id:3",
      "ZY22ABCDEF             offline usb:1-3 transport_id:4",
      "emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:2",
      "192.168.1.5:5555       device product:panther model:Pixel_7 transport_id:5",
      "adb-1A2B3C-xyz._adb-tls-connect._tcp device product:panther model:Pixel_7 transport_id:6",
      "",
    ].join("\r\n");

    assert.deepStrictEqual(parseAdbDevices(stdout), [
      { serial: "R58M12345ABC", state: "device", name: "SM G973F" },
      { serial: "0123456789ABCDEF", state: "unauthorized", name: "0123456789ABCDEF" },
      { serial: "ZY22ABCDEF", state: "offline", name: "ZY22ABCDEF" },
    ]);
  });

  it("keeps the multi-word no permissions state", () => {
    assert.deepStrictEqual(
      parseAdbDevices(
        "List of devices attached\nABC123 no permissions (missing udev rules?); see [http://developer.android.com/tools/device.html] usb:1-1\n",
      ),
      [{ serial: "ABC123", state: "no permissions", name: "ABC123" }],
    );
  });
});

describe("adbExecutableCandidates", () => {
  it("prefers SDK locations, then PATH entries, without duplicates", () => {
    assert.deepStrictEqual(
      adbExecutableCandidates({
        env: { ANDROID_HOME: "/sdk", PATH: "/opt/homebrew/bin:/sdk/platform-tools:" },
        platform: "darwin",
        homeDirectory: "/Users/me",
      }),
      [
        "/sdk/platform-tools/adb",
        "/Users/me/Library/Android/sdk/platform-tools/adb",
        "/opt/homebrew/share/android-commandlinetools/platform-tools/adb",
        "/opt/homebrew/bin/adb",
      ],
    );
    assert.deepStrictEqual(
      adbExecutableCandidates({
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", Path: "C:\\tools" },
        platform: "win32",
        homeDirectory: "C:\\Users\\me",
      }),
      [
        "C:\\Users\\me\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe",
        "C:\\tools\\adb.exe",
      ],
    );
  });
});
