import { tm } from '../i18n';

/**
 * Host bindings usable outside React (search providers, stores, callbacks).
 * ModuleHost keeps them in sync with the core app state.
 */
const host = {
  language: 'en',
  navigate: (_route: string) => {},
};

export function bindHost(next: Partial<typeof host>) {
  Object.assign(host, next);
}

/** Module translation outside of components. */
export const tmStatic = (key: string) => tm(host.language, key);

/** Navigate to a core route ('home', 'explore', guild id) or a module route ('diary:<id>'). */
export const goTo = (route: string) => host.navigate(route);

/**
 * A module holding the user in a live audio session (e.g. a voice room) marks
 * itself busy; the core then declines incoming DM calls instead of ringing.
 */
const busy = new Set<string>();
export const setBusy = (moduleId: string, on: boolean) => { if (on) busy.add(moduleId); else busy.delete(moduleId); };
export const isBusy = () => busy.size > 0;
