import { useEffect, useState } from 'react';
import type { SimDevice } from '@shared/api';
import { errText, request, setState, toast, useApp, type Conn } from '../store';

// The simulator pane (/simulator): an iOS Simulator device beside the
// sessions, its screen captured about once a second (config.json
// simulatorFps) while it is on screen, not under a panel and not in a hidden or
// minimized window (main/simulator.ts). Boot starts a device; Open in
// Simulator is where you tap; Show Claude sends the active session a capture
// to check its own changes (only a session on this Mac).
export function SimulatorPane({ conn, covered }: { conn: Conn | null; covered: boolean }) {
  const fps = useApp((s) => s.simulatorFps);
  const [devices, setDevices] = useState<SimDevice[] | null>(null);
  const [udid, setUdid] = useState<string | null>(null);
  const [screen, setScreen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const [shown, setShown] = useState(document.visibilityState === 'visible');
  const device = devices?.find((d) => d.udid === udid) ?? null;

  const list = () =>
    window.binder.simDevices().then(
      (d) => {
        setDevices(d);
        setUdid((u) => u ?? d.find((x) => x.booted)?.udid ?? d[0]?.udid ?? null);
      },
      (e) => setError(errText(e)),
    );
  useEffect(() => void list(), []);

  // A hidden or minimized window (macOS also counts one fully covered).
  useEffect(() => {
    const seen = () => setShown(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  }, []);

  // The screen, again and again while the device runs and the pane shows.
  // Each run has its own flag, so a capture in flight when it ends stops there.
  useEffect(() => {
    if (!device?.booted || covered || !shown) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = async () => {
      const start = Date.now();
      try {
        const s = await window.binder.simShot(device.udid, 'jpeg');
        if (!alive) return;
        setScreen(`data:${s.mediaType};base64,${s.data}`);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(errText(e));
      }
      timer = setTimeout(() => void next(), Math.max(100, 1000 / fps - (Date.now() - start)));
    };
    void next();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [device?.udid, device?.booted, covered, shown, fps]);

  const boot = () => {
    if (!device) return;
    setBooting(true);
    window.binder.simBoot(device.udid).then(
      () => {
        setBooting(false);
        void list();
      },
      (e) => {
        setBooting(false);
        toast(errText(e), true);
      },
    );
  };
  const showClaude = async () => {
    if (!device || !conn) return;
    if (conn.computer) return toast('The simulator runs on this Mac: show it to a session here', true);
    try {
      const s = await window.binder.simShot(device.udid, 'png');
      const tabId = conn.activeTab ?? conn.state?.tabs.at(-1)?.id;
      await request(conn.id, 'send', { text: `Here is the iOS Simulator (${device.name}, ${device.runtime}) as it looks now.\n\nCheck that it shows what you changed, and fix anything that is wrong.`, images: [s], ...(tabId !== undefined && { tabId }) });
      toast('Sent the simulator to Claude');
    } catch (e) {
      toast(errText(e), true);
    }
  };

  return (
    <aside className="side-pane sim-pane">
      <div className="titlebar">
        <select value={udid ?? ''} onChange={(e) => (setScreen(null), setUdid(e.target.value))} disabled={!devices?.length}>
          {(devices ?? []).map((d) => (
            <option key={d.udid} value={d.udid}>
              {d.name} · {d.runtime}
              {d.booted ? ' · running' : ''}
            </option>
          ))}
        </select>
        {device && !device.booted && (
          <button className="boot" disabled={booting} onClick={boot}>
            {booting ? 'Booting…' : 'Boot'}
          </button>
        )}
        <button title="Open this device in the Simulator app, to tap and type" disabled={!device} onClick={() => device && window.binder.simOpenApp(device.udid)}>
          Open in Simulator
        </button>
        <button className="show-claude" title="Send the active session a capture of the screen" disabled={!device?.booted || !conn} onClick={() => void showClaude()}>
          Show Claude
        </button>
        <button className="side-close" title="Close the simulator pane (/simulator)" onClick={() => setState({ simulator: false })}>
          ×
        </button>
      </div>
      <div className="sim-screen">
        {error && !screen ? (
          <div className="note">{error}</div>
        ) : !devices ? (
          <div className="note">Asking Xcode for its simulators…</div>
        ) : !device ? (
          <div className="note">No simulators: add one in Xcode (Window › Devices and Simulators).</div>
        ) : !device.booted ? (
          <div className="note">{device.name} is not running. Boot starts it.</div>
        ) : screen ? (
          <img src={screen} alt={`${device.name} screen`} />
        ) : (
          <div className="note">Capturing the screen…</div>
        )}
      </div>
    </aside>
  );
}
