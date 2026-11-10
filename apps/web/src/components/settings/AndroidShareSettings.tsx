import type { DesktopAndroidDevice, DesktopAndroidShare } from "@t3tools/contracts";
import { useEffect } from "react";

import {
  androidShareBridge,
  retainAndroidShareWatching,
  setAndroidShareEnabled,
  useAndroidShareState,
  useDesiredAndroidShares,
} from "../../state/androidShare";
import { androidShareKey } from "../../state/androidShare.logic";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface ShareLine {
  readonly text: string;
  readonly tone: "muted" | "error" | "pending";
}

function describeShare(input: {
  readonly device: DesktopAndroidDevice | undefined;
  readonly share: DesktopAndroidShare | undefined;
  readonly wanted: boolean;
  readonly environmentLabel: string;
}): ShareLine {
  const { device, share, wanted, environmentLabel } = input;
  switch (share?.status) {
    case "connecting":
      return { text: "Connecting…", tone: "pending" };
    case "waiting-for-phone":
      return { text: "Unlock the phone and allow USB debugging.", tone: "error" };
    case "shared":
      return { text: `Shared with ${environmentLabel}`, tone: "muted" };
    case "interrupted":
      return {
        text: `Interrupted. Sharing resumes when the phone and ${environmentLabel} are both back.`,
        tone: "error",
      };
    case "remote-adb-missing":
      return {
        text: `${environmentLabel} has no adb. Install Android platform-tools on its machine.`,
        tone: "error",
      };
    case "failed":
      return { text: share.detail ?? "Sharing failed.", tone: "error" };
    case undefined:
      break;
  }
  if (device === undefined) {
    return { text: "Phone not connected. Sharing resumes when it is plugged in.", tone: "error" };
  }
  if (device.state === "unauthorized") {
    return { text: "Allow USB debugging on the phone to share it.", tone: "error" };
  }
  if (device.state !== "device") {
    return { text: `Not ready (${device.state}). Reconnect the cable.`, tone: "error" };
  }
  return wanted ? { text: "Starting…", tone: "pending" } : { text: "Not shared", tone: "muted" };
}

/**
 * Phones plugged into this computer, offered to the selected environment. Only the desktop app can
 * see them, and the desktop's own environment already does.
 */
export function AndroidShareSettings() {
  const { environment } = useSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (
    androidShareBridge() === null ||
    environment === null ||
    environment.environmentId === primaryEnvironmentId
  ) {
    return null;
  }
  return (
    <AndroidShareList
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
    />
  );
}

function AndroidShareList(props: { environmentId: string; environmentLabel: string }) {
  const { environmentId, environmentLabel } = props;
  const state = useAndroidShareState();
  const desired = useDesiredAndroidShares();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the desktop only polls adb while something watches
  useEffect(() => retainAndroidShareWatching(), []);

  const wanted = new Set(
    desired.filter((entry) => entry.environmentId === environmentId).map((entry) => entry.serial),
  );
  const shares = new Map(
    (state?.shares ?? [])
      .filter((share) => share.environmentId === environmentId)
      .map((share) => [share.serial, share]),
  );
  const devices = new Map((state?.devices ?? []).map((device) => [device.serial, device]));
  // A phone that was unplugged stays listed while it is switched on, so it can be switched off.
  const serials = [...new Set([...devices.keys(), ...wanted])];

  return (
    <SettingsSection id="android-share" title="This computer's devices">
      {state === null ? (
        <SettingsRow
          title="Android phones"
          description="Looking for phones plugged into this computer…"
          control={<Spinner size="xs" />}
        />
      ) : !state.adbAvailable ? (
        <SettingsRow
          title="Android platform-tools not found"
          description="Install Android platform-tools on this computer to share a phone, for example with brew install --cask android-platform-tools."
        />
      ) : serials.length === 0 ? (
        <SettingsRow
          title="No phones connected"
          description={`Plug in an Android phone with USB debugging turned on to share it with ${environmentLabel}.`}
        />
      ) : (
        serials.map((serial) => {
          const device = devices.get(serial);
          const share = shares.get(serial);
          const isWanted = wanted.has(serial);
          const line = describeShare({ device, share, wanted: isWanted, environmentLabel });
          const ready = device?.state === "device";
          const name = device?.name ?? serial;
          return (
            <SettingsRow
              key={androidShareKey({ environmentId, serial })}
              title={name}
              description={
                <span
                  role="status"
                  className={line.tone === "error" ? "text-destructive" : undefined}
                >
                  {line.text}
                </span>
              }
              control={
                <>
                  {line.tone === "pending" ? <Spinner size="xs" /> : null}
                  <Switch
                    checked={isWanted}
                    disabled={!ready && !isWanted}
                    aria-label={`Share ${name} with ${environmentLabel}`}
                    onCheckedChange={(checked) =>
                      setAndroidShareEnabled({ environmentId, serial }, checked)
                    }
                  />
                </>
              }
            />
          );
        })
      )}
    </SettingsSection>
  );
}
