export function openWorkspace(id: string, navigate: (route: string) => void, settings: (page: string) => void) {
  const setting = ({ family: 'family', totp: 'totp', multiserver: 'servers' } as Record<string, string>)[id];
  if (setting) { navigate('settings'); settings(setting); }
  else navigate(`${id}:`);
}
