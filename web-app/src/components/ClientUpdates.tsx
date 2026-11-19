import { useState } from 'react';

/** The selected chat server cannot choose an executable, URL, or release key. */
export function ClientUpdates() {
  const [notice, setNotice] = useState('');
  const bridge = window as Window & { SphereUpdates?: { open: () => void }; SphereUpdatesHost?: { postMessage: (message: string) => void } };
  const open = () => {
    try {
      if (bridge.SphereUpdates?.open) bridge.SphereUpdates.open();
      else if (bridge.SphereUpdatesHost?.postMessage) bridge.SphereUpdatesHost.postMessage('open');
      else if (bridge.webkit?.messageHandlers?.openReleaseUpdates) bridge.webkit.messageHandlers.openReleaseUpdates.postMessage(null);
      else { setNotice('Эта версия не предоставляет встроенное обновление приложения. Используйте подписанный выпуск издателя или магазин приложений.'); return; }
      setNotice('Продолжите проверку в системном окне обновления.');
    } catch { setNotice('Не удалось открыть средство обновления приложения.'); }
  };
  return <details style={{ marginBlock: 20 }}><summary>Обновление приложения</summary>
    <p>Проверка и установка выполняются приложением или системным магазином. Файлы обновления и ключи доверия не берутся с выбранного сервера чатов.</p>
    <button onClick={open}>Проверить обновление приложения</button>
    {notice && <p role="status">{notice}</p>}
  </details>;
}
