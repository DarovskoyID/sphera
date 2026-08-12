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

/**
 * The set of keys every locale must provide, each mapped to a string.
 *
 * Deliberately not `typeof en`: that types every entry as the *literal* English
 * text, so `auth_login: 'Логин'` is an error because it is not `'Login'`. Every
 * translated line in every locale failed that way — over two thousand errors,
 * which is why `npm run typecheck` was unusable and real mistakes hid among
 * them. Keys are still checked exactly; only the values are free.
 */
export type Translations = Record<keyof typeof en, string>;

const all: Record<LangCode, Translations> = { en, ru, es, zh, fr, de, pt };

export function t(lang: string, key: keyof Translations): string {
  const code = (lang in all ? lang : 'en') as LangCode;
  return all[code][key] ?? all.en[key] ?? key;
}
