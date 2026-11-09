import { ListGroup, SubpageHeader, Switch } from '../components/ui.tsx';
import { MOTION_TOGGLES, reduced, setMotion, TOUCH_TOGGLES, useMotion, type Motion } from '../lib/motion-settings.ts';
import { native } from '../lib/native.ts';

type Toggle = (typeof MOTION_TOGGLES | typeof TOUCH_TOGGLES)[number];

function Toggles({ label, toggles }: { label: string; toggles: readonly Toggle[] }) {
  const motion = useMotion();
  return (
    <ListGroup
      label={label}
      rows={toggles.map(([key, title, subtitle]) => ({
        title,
        subtitle,
        trailing: <Switch checked={motion[key]} onChange={(v) => setMotion({ [key]: v } as Partial<Motion>)} label={title} />,
      }))}
    />
  );
}

/** Settings → Motion: how pages and rows move, each one to turn off on this device. */
export function MotionSettings() {
  return (
    <>
      <SubpageHeader title="Motion" back="/settings" />
      {reduced() && (
        <p className="mb-3 rounded-2xl bg-surface-high px-4 py-3 text-sm text-on-surface-variant">
          Your phone is set to remove animations, so Amble keeps them to a minimum whatever's on here.
        </p>
      )}
      <Toggles label="Motion" toggles={MOTION_TOGGLES} />
    </>
  );
}

/**
 * Settings → Touch: what a finger sees and feels, each one to turn off on this device. Haptics only
 * where the device can make them: the Android app, or a browser that can vibrate.
 */
export function TouchSettings() {
  return (
    <>
      <SubpageHeader title="Touch" back="/settings" />
      {reduced() && (
        <p className="mb-3 rounded-2xl bg-surface-high px-4 py-3 text-sm text-on-surface-variant">
          Your phone is set to remove animations, so a tap shows a plain tint instead of a ripple.
        </p>
      )}
      <Toggles label="Touch" toggles={TOUCH_TOGGLES.filter(([key]) => key !== 'haptics' || native || 'vibrate' in navigator)} />
    </>
  );
}
