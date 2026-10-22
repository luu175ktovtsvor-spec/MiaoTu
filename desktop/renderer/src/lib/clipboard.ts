export { readClipboardText, writeClipboardText } from '../clipboard'
export async function readClipboardFiles(): Promise<File[]> {
  if (window.miaoDesktop) {
    const entries = await window.miaoDesktop.readClipboardMedia();
    return entries.map(entry => new File([Uint8Array.from(atob(entry.data), ch => ch.charCodeAt(0))], entry.name, { type: entry.type }));
  }
  if (!navigator.clipboard?.read) return [];
  const files: File[] = [];
  for (const item of await navigator.clipboard.read()) for (const type of item.types.filter(type => /^(image|audio|video)\//.test(type))) {
    files.push(new File([await item.getType(type)], `pasted-media-${files.length}.${type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'}`, { type }));
  }
  return files;
}
