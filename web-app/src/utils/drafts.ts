// Local message drafts — kept entirely on the client (localStorage for text,
// an in-memory map for File objects which can't be serialized). Lets unsent text
// and attachments survive switching channels / chats / tabs within a session.
//
// Scope is an arbitrary string id, e.g. a conversation id, guild-channel id, etc.

const fileStore = new Map<string, File[]>();
const textKey = (scope: string) => `sfera_draft_text_${scope}`;

export function getDraftText(scope: string): string {
  if (!scope) return '';
  try { return localStorage.getItem(textKey(scope)) || ''; } catch { return ''; }
}

export function setDraftText(scope: string, text: string): void {
  if (!scope) return;
  try {
    if (text) localStorage.setItem(textKey(scope), text);
    else localStorage.removeItem(textKey(scope));
  } catch { /* ignore quota / disabled storage */ }
}

export function getDraftFiles(scope: string): File[] {
  if (!scope) return [];
  return fileStore.get(scope) || [];
}

export function setDraftFiles(scope: string, files: File[]): void {
  if (!scope) return;
  if (files.length) fileStore.set(scope, files);
  else fileStore.delete(scope);
}

export function clearDraft(scope: string): void {
  setDraftText(scope, '');
  setDraftFiles(scope, []);
}
