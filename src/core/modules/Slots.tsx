import type { ComposerActionProps } from '../../sdk/slots';
import { useSlot } from '../../sdk/slots';

/**
 * Buttons modules add next to a message composer.
 *
 * Wrapped in a span that is `display: contents` on a wide screen and hidden on
 * a phone (layout.css): the row by the message box is narrow, and three module
 * icons there crowd out typing. The modules themselves stay reachable from the
 * dock and from «Исследовать сферу».
 */
export function ComposerActions(props: ComposerActionProps) {
  const actions = useSlot('chat.composerAction');
  if (!props.targetId || actions.length === 0) return null;
  return (
    <span className="composer-module-actions">
      {actions.map(a => <a.render key={`${a.moduleId}:${a.id}`} {...props} />)}
    </span>
  );
}

/** Buttons modules add to the left rail. */
export function RailSlot() {
  const items = useSlot('nav.rail');
  return <>{items.map(i => <i.render key={`${i.moduleId}:${i.id}`} />)}</>;
}

export function SlotList({ slot }: { slot: 'sidebar.userPanel' | 'nav.railScroll' | 'app.overlay' | 'auth.footer' }) {
  const items = useSlot(slot);
  return <>{items.map(i => <i.render key={`${i.moduleId}:${i.id}`} />)}</>;
}
