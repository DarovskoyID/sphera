import { en } from './en';
import { ru } from './ru';
import { es } from './es';
import { zh } from './zh';
import { fr } from './fr';
import { de } from './de';
import { pt } from './pt';

export type LangCode = 'en' | 'ru' | 'es' | 'zh' | 'fr' | 'de' | 'pt';

export const languages: Record<LangCode, string> = {
  en: 'English',
  ru: 'Русский',
  es: 'Español',
  zh: '中文',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
};

export type Translations = typeof en;

const all: Record<LangCode, Translations> = { en, ru, es, zh, fr, de, pt };

export function t(lang: string, key: keyof Translations): string {
  const code = (lang in all ? lang : 'en') as LangCode;
  return all[code][key] ?? all.en[key] ?? key;
}
