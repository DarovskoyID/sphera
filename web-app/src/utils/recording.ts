// Picks a MediaRecorder mimeType the current browser actually supports.
// iOS Safari (and some Android browsers) don't support `video/webm` — they use
// mp4/H.264 — so hard-coding webm makes recording throw and silently fail on
// mobile. Returns the first supported candidate plus a matching file extension;
// `mimeType` may be undefined, in which case construct MediaRecorder without
// options and let the browser choose.

export interface RecorderFormat {
  mimeType?: string;
  ext: string;
}

const VIDEO_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=h264,aac',
  'video/mp4',
];

const AUDIO_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/aac',
];

function extFor(mimeType: string | undefined, mode: 'voice' | 'video'): string {
  if (mimeType && mimeType.includes('mp4')) return mode === 'video' ? 'mp4' : 'm4a';
  if (mimeType && mimeType.includes('aac')) return 'aac';
  return 'webm';
}

// Returns a human-readable reason why recording can't even start, or null if the
// environment supports it. The most common mobile case: the page is served over
// http (not https/localhost), so the browser hides navigator.mediaDevices.
export function mediaUnsupportedReason(): string | null {
  if (typeof navigator !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
    return null;
  }
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'Запись камеры и микрофона работает только по защищённому соединению (HTTPS). Откройте приложение по https:// (на телефоне http не разрешает доступ к камере).';
  }
  return 'Этот браузер не поддерживает запись камеры/микрофона.';
}

// Maps a getUserMedia / MediaRecorder error to a user-facing message.
export function describeMediaError(e: unknown): string {
  const name = (e as { name?: string })?.name || '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Доступ к камере/микрофону запрещён. Разрешите доступ в настройках браузера и попробуйте снова.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Камера или микрофон не найдены.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Камера/микрофон уже используются другим приложением.';
    default:
      return 'Не удалось начать запись. Проверьте доступ к камере и микрофону.';
  }
}

export function pickRecorderFormat(mode: 'voice' | 'video'): RecorderFormat {
  const candidates = mode === 'video' ? VIDEO_CANDIDATES : AUDIO_CANDIDATES;
  const supported = typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function';
  const mimeType = supported ? candidates.find(c => MediaRecorder.isTypeSupported(c)) : undefined;
  return { mimeType, ext: extFor(mimeType, mode) };
}
