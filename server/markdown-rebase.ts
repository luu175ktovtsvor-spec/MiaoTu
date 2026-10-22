import { parse, postprocess, preprocess } from 'micromark';
import { decodeString } from 'micromark-util-decode-string';
import { Parser } from 'htmlparser2';
import { resolveMarkdownPath } from './markdown-file-references.ts';
import { workspaceFileReference, type WorkspaceReferenceScope } from './workspace-path.ts';

type Replacement = { from: number; to: number; value: string };
const encodePart = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

// Change destination spans only. The parsers supply their original offsets,
// so titles, reference syntax, whitespace and code examples stay verbatim.
export function rebaseMarkdownPaths(text: string, sourcePath: string, targetPath: string, options: { mapPath?: (path: string) => string; scope?: WorkspaceReferenceScope } = {}) {
  const targetDirectory = targetPath.split('/').slice(0, -1);
  if (sourcePath === targetPath && !options.mapPath) return text;
  const bom = text.startsWith('\ufeff') ? '\ufeff' : '';
  if (bom) text = text.slice(1);
  const mapPath = options.mapPath ?? (path => path === sourcePath ? targetPath : path);
  const replacements: Replacement[] = [];
  const rebased = (value: string) => {
    if (/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(value)) {
      const reference = options.scope && workspaceFileReference(value, options.scope);
      if (!reference?.sameScope) return;
      const next = mapPath(reference.path);
      if (next === reference.path) return;
      const url = new URL(value, options.scope?.origin || 'http://workspace.invalid');
      url.searchParams.set('path', next);
      url.searchParams.delete('v');
      return value.startsWith('/') ? `${url.pathname}${url.search}${url.hash}` : url.href;
    }
    let path: string | undefined;
    try { path = resolveMarkdownPath(value, sourcePath); } catch { return; }
    if (!path) return;
    path = mapPath(path);
    try { if (resolveMarkdownPath(value, targetPath) === path) return; } catch { /* A shallower destination may need a new relative path. */ }
    const parts = path.split('/');
    let shared = 0;
    while (shared < targetDirectory.length && shared < parts.length && targetDirectory[shared] === parts[shared]) shared++;
    const relative = [...targetDirectory.slice(shared).map(() => '..'), ...parts.slice(shared)].map(encodePart).join('/');
    const suffix = value.match(/[?#].*$/s)?.[0] ?? '';
    return relative + suffix.replace(/[\s"'`<>\\()[\]]/g, encodePart);
  };
  const html = (source: string, offset: number) => {
    let tag = '';
    const parser = new Parser({
      onopentagname(name) { tag = name; },
      onattribute(name, value, quote) {
        if (!(tag === 'img' && name === 'src' || tag === 'a' && name === 'href')) return;
        const next = rebased(value);
        if (next === undefined) return;
        const raw = source.slice(parser.startIndex, parser.endIndex + 1);
        const prefix = /^[^\s=/>]+\s*=\s*["']?/.exec(raw);
        if (!prefix) return;
        const from = parser.startIndex + prefix[0].length;
        const to = quote ? source.indexOf(quote, from) : from + /^[^\t\n\f\r >]*/.exec(source.slice(from))![0].length;
        if (to < from) return;
        replacements.push({ from: offset + from, to: offset + to,
          value: next.replaceAll('&', '&amp;') });
      },
    });
    parser.end(source);
  };
  const events = postprocess(parse().document().write(preprocess()(text, undefined, true)));
  for (const [event, token] of events) {
    if (event !== 'enter') continue;
    const from = token.start.offset, to = token.end.offset;
    if (token.type === 'resourceDestinationString' || token.type === 'definitionDestinationString') {
      const value = rebased(decodeString(text.slice(from, to)));
      if (value !== undefined) replacements.push({ from, to, value });
    } else if (token.type === 'htmlFlow' || token.type === 'htmlText') html(text.slice(from, to), from);
  }
  const result: string[] = [];
  let copied = 0;
  for (const replacement of replacements.sort((a, b) => a.from - b.from)) {
    result.push(text.slice(copied, replacement.from), replacement.value);
    copied = replacement.to;
  }
  result.push(text.slice(copied));
  return bom + result.join('');
}
