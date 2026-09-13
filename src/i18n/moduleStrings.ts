/** Translation dictionaries contributed by modules at runtime. */
const byModule = new Map<string, Partial<Record<string, Record<string, string>>>>();

export function registerModuleStrings(moduleId: string, dicts: Partial<Record<string, Record<string, string>>>) {
  byModule.set(moduleId, dicts);
  return () => { byModule.delete(moduleId); };
}

export function lookupModuleString(lang: string, key: string): string | undefined {
  for (const dicts of byModule.values()) {
    const v = dicts[lang]?.[key] ?? dicts.en?.[key];
    if (v !== undefined) return v;
  }
  return undefined;
}
