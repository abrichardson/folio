import { invoke } from '@tauri-apps/api/core';

/**
 * Saves text to a file the user picks. The desktop app shows the system Save dialog;
 * a plain browser (development only) uses a regular download. Resolves to false if the
 * user cancels.
 */
export async function saveTextFile(name: string, text: string, type = 'text/plain') {
  if ('__TAURI_INTERNALS__' in window) {
    try {
      return await invoke<boolean>('save_text_file', { defaultName: name, contents: text });
    } catch (e) {
      throw new Error(typeof e === 'string' ? e : 'The file could not be saved.');
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
