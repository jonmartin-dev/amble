import { ListGroup, SubpageHeader, Switch } from '../components/ui.tsx';
import { reduced, setMotion, TOGGLES, useMotion, type Motion } from '../lib/motion-settings.ts';

/** Settings → Motion: the gestures and touches, each one to turn off on this device. */
export function MotionSettings() {
  const motion = useMotion();
  return (
    <>
      <SubpageHeader title="Motion" back="/settings" />
      {reduced() && (
        <p className="mb-3 rounded-2xl bg-surface-high px-4 py-3 text-sm text-on-surface-variant">
          Your phone is set to remove animations, so Amble keeps them to a minimum whatever's on here.
        </p>
      )}
      <ListGroup
        label="Motion"
        rows={TOGGLES.map(([key, title, subtitle]) => ({
          title,
          subtitle,
          trailing: <Switch checked={motion[key]} onChange={(v) => setMotion({ [key]: v } as Partial<Motion>)} label={title} />,
        }))}
      />
    </>
  );
}
