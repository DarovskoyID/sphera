/**
 * Module routes live in `currentServer` as `<moduleId>:<rest>` (e.g. `diary:<uuid>`),
 * matched by a `main.view` slot. Core routes are 'home' | 'explore' | 'settings' | <guild id>.
 */
export const moduleRoute = (moduleId: string, rest = '') => `${moduleId}:${rest}`;

export function parseModuleRoute(currentServer: string, moduleId: string): string | null {
  const prefix = `${moduleId}:`;
  return currentServer.startsWith(prefix) ? currentServer.slice(prefix.length) : null;
}

export const navigate = { moduleRoute, parseModuleRoute };
