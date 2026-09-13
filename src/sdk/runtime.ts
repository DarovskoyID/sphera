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
