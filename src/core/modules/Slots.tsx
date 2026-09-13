import type { ComposerActionProps } from '../../sdk/slots';
import { useSlot } from '../../sdk/slots';

/** Buttons modules add next to a message composer. */
export function ComposerActions(props: ComposerActionProps) {
  const actions = useSlot('chat.composerAction');
  if (!props.targetId) return null;
  return <>{actions.map(a => <a.render key={`${a.moduleId}:${a.id}`} {...props} />)}</>;
}

/** Buttons modules add to the left rail. */
export function RailSlot() {
  const items = useSlot('nav.rail');
  return <>{items.map(i => <i.render key={`${i.moduleId}:${i.id}`} />)}</>;
}

export function SlotList({ slot }: { slot: 'sidebar.userPanel' | 'nav.railScroll' | 'app.overlay' }) {
  const items = useSlot(slot);
  return <>{items.map(i => <i.render key={`${i.moduleId}:${i.id}`} />)}</>;
}
