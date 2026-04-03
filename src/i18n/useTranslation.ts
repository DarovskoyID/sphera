import { useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { t, type Translations } from './index';

export function useTranslation() {
  const { language } = useApp();

  const tr = useCallback(
    (key: keyof Translations) => t(language, key),
    [language],
  );

  return tr;
}
