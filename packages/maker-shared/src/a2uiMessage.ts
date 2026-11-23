import { unified } from 'unified';
import remarkParse from 'remark-parse';

/** The wire version and the SDK release are deliberately separate identifiers. */
export const A2UI_SDK_VERSION = '0.15.0';
export const A2UI_PROTOCOL_VERSION = '1.0';
export const A2UI_BASIC_CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

export interface A2uiMessagePart {
  kind: 'markdown' | 'a2ui';
  source: string;
  key: number;
  complete: boolean;
}

const markdownParser = unified().use(remarkParse);

/** Only root-level Markdown code nodes opt in; lists, quotes and HTML stay inert. */
export function splitA2uiMessage(source: string): A2uiMessagePart[] {
  // Ordinary chat messages do not need an additional Markdown parse.
  if (!/(?:^|\n) {0,3}(?:`{3,}|~{3,})[ \t]*a2ui[ \t]*(?:\r?\n|$)/.test(source)) {
    return source ? [{ kind: 'markdown', source, key: 0, complete: false }] : [];
  }
  const parts: A2uiMessagePart[] = [];
  let start = 0;
  for (const node of markdownParser.parse(source).children) {
    if (node.type !== 'code' || node.lang !== 'a2ui' || node.meta) continue;
    const offset = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (offset === undefined || to === undefined) continue;
    // Include root-fence indentation, preserving the historical fragment key.
    const from = offset - (node.position!.start.column - 1);
    const raw = source.slice(from, to);
    const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*a2ui[ \t]*\r?\n/.exec(raw);
    if (!opening) continue;
    // CommonMark also produces a code node for an unfinished streaming fence.
    const closing = raw.slice(raw.lastIndexOf('\n') + 1);
    if (!new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*\\r?$`).test(closing)) continue;
    if (from > start) parts.push({ kind: 'markdown', source: source.slice(start, from), key: start, complete: true });
    parts.push({ kind: 'a2ui', source: node.value, key: from, complete: true });
    start = to;
  }
  // Do not enable controls from a partial stream, even if its prefix parses.
  if (start < source.length) parts.push({ kind: 'markdown', source: source.slice(start), key: start, complete: false });
  return parts;
}

/** Host admission policy, followed by the official processor's schema/graph validation.
 * This is NOT an alternate implementation of the official A2UI schema.
 * Functions/RPC are not part of the message-card contract: they must never execute
 * merely because a model described them. Media implementations must use host ports.
 */
export function readA2uiEnvelopes(source: string): Record<string, unknown>[] {
  if (new TextEncoder().encode(source).length > 128 * 1024) throw new Error('A2UI message exceeds 128 KiB');
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch { parsed = source.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
  const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (!messages.length || messages.length > 256) throw new Error('Invalid A2UI message count');
  let nodes = 0;
  const inspect = (value: unknown, depth = 0): void => {
    if (depth > 32 || ++nodes > 16000) throw new Error('A2UI message is too complex');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['@call', 'call', 'functionCall', '__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsupported A2UI executable expression');
      if (key === 'checks' || key === '@checks') throw new Error('Unsupported A2UI checks');
      inspect(child, depth + 1);
    }
  };
  let surfaceId: string | undefined;
  let count = 0;
  for (const value of messages) {
    inspect(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid A2UI envelope');
    const message = value as Record<string, unknown>;
    if (message.version !== A2UI_PROTOCOL_VERSION) throw new Error('Unsupported A2UI version');
    const keys = Object.keys(message).filter(key => key !== 'version');
    if (keys.length !== 1 || !['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'].includes(keys[0])) throw new Error('Unsupported A2UI operation');
    const operation = message[keys[0]];
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new Error('Invalid A2UI operation');
    const payload = operation as Record<string, unknown>;
    if (payload.theme !== undefined) throw new Error('A2UI uses the host theme');
    if (keys[0] === 'createSurface') {
      if (++count !== 1 || payload.catalogId !== A2UI_BASIC_CATALOG || payload.sendDataModel === true) throw new Error('Unsupported A2UI surface');
      if (typeof payload.surfaceId !== 'string' || !payload.surfaceId || payload.surfaceId.length > 128) throw new Error('Invalid A2UI surface id');
      surfaceId = payload.surfaceId;
    }
    if (!surfaceId || payload.surfaceId !== surfaceId) throw new Error('A2UI surface is outside this message');
  }
  if (!surfaceId) throw new Error('Missing A2UI surface');
  return messages as Record<string, unknown>[];
}

/** Delivery classification must use the same Markdown boundary as the renderer. */
export const hasA2uiAnswer = (source: string): boolean =>
  splitA2uiMessage(source).some(part => part.kind === 'a2ui');

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const safeKeys = (path: string): string[] => {
  if (!path.startsWith('/')) throw new Error('Expected an absolute data path');
  const keys = path.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('Unsafe data path');
  return keys;
};

/** Read-only projection of the delivered snapshot, never local drafts or actions.
 * Not a schema validator or renderer: the official SDK still admits/renders cards.
 * Unprojectable input stays as readable source and contributes no media dedup keys.
 */
function projectA2ui(source: string): { text: string; media: string[] } | undefined {
  try {
    const messages = readA2uiEnvelopes(source);
    let surfaceId: string | undefined;
    let data: unknown = {};
    const components = new Map<string, RecordValue>();
    for (const message of messages) {
      if (!record(message) || message.version !== '1.0') return undefined;
      const ops = Object.keys(message).filter(key => key !== 'version');
      if (ops.length !== 1 || !record(message[ops[0]])) return undefined;
      const op = ops[0];
      const payload = message[op] as RecordValue;
      if (op === 'createSurface') {
        if (surfaceId || typeof payload.surfaceId !== 'string' || payload.catalogId !== A2UI_BASIC_CATALOG) return undefined;
        surfaceId = payload.surfaceId;
        data = payload.dataModel ?? {};
      }
      if (!surfaceId || payload.surfaceId !== surfaceId) return undefined;
      if (op === 'createSurface' || op === 'updateComponents') {
        const definitions = payload.components ?? (op === 'createSurface' ? [] : undefined);
        if (!Array.isArray(definitions)) return undefined;
        for (const component of definitions) {
          if (!record(component) || typeof component.id !== 'string' || typeof component.component !== 'string') return undefined;
          components.set(component.id, component);
        }
        if (components.size > 2048) return undefined;
      } else if (op === 'updateDataModel') {
        if (payload.path === undefined || payload.path === '/') data = payload.value;
        else {
          if (typeof payload.path !== 'string') return undefined;
          const keys = safeKeys(payload.path);
          let target = data;
          for (const key of keys.slice(0, -1)) {
            if (!record(target)) return undefined;
            if (!record(target[key])) target[key] = {};
            target = target[key];
          }
          if (!record(target)) return undefined;
          target[keys[keys.length - 1]] = payload.value;
        }
      } else return undefined; // Deleted surfaces have no displayed media.
    }
    const resolve = (value: unknown): string => {
      if (record(value) && typeof value['@path'] === 'string') {
        let resolved = data;
        for (const key of safeKeys(value['@path'])) {
          resolved = (record(resolved) || Array.isArray(resolved)) && Object.hasOwn(resolved, key)
            ? (resolved as RecordValue)[key] : undefined;
        }
        value = resolved;
      }
      return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    };
    const text: string[] = [];
    const media: string[] = [];
    const visited = new Set<string>();
    let visits = 0;
    const walk = (id: unknown, depth = 0): void => {
      if (typeof id !== 'string' || depth > 32 || ++visits > 16000 || visited.has(id)) throw new Error('Invalid component graph');
      const node = components.get(id);
      if (!node) throw new Error('Missing component');
      visited.add(id);
      const add = (value: unknown) => { const line = resolve(value); if (line) text.push(line); };
      switch (node.component) {
        case 'Text': add(node.text); break;
        case 'TextField': add(node.label); if (node.variant !== 'obscured') add(node.value); break;
        case 'ChoicePicker': add(node.label); break;
        case 'Image': case 'AudioPlayer': {
          add(node.description);
          const url = resolve(node.url);
          if (url) { text.push(url); media.push(url); }
          break;
        }
        case 'Column': case 'Row':
          if (!Array.isArray(node.children)) throw new Error('Unsupported children');
          for (const child of node.children) walk(child, depth + 1);
          break;
        case 'Card': case 'Button': walk(node.child, depth + 1); break;
        case 'Tabs':
          if (!Array.isArray(node.tabs)) throw new Error('Invalid tabs');
          for (const tab of node.tabs) {
            if (!record(tab)) throw new Error('Invalid tab');
            add(tab.title); walk(tab.child, depth + 1);
          }
          break;
        case 'Divider': break;
        default: throw new Error('Unsupported component');
      }
      visited.delete(id);
    };
    walk('root');
    return { text: text.join('\n'), media };
  } catch { return undefined; }
}

/** Copy the persisted reading content, not the protocol or unsent local answers. */
export function a2uiReadableText(source: string): string {
  return splitA2uiMessage(source).map(part => part.kind === 'markdown' ? part.source
    : projectA2ui(part.source)?.text ?? `\`\`\`a2ui\n${part.source}\n\`\`\``).join('');
}

export function a2uiMediaSources(source: string): ReadonlySet<string> {
  return new Set(splitA2uiMessage(source).flatMap(part => part.kind === 'a2ui'
    ? projectA2ui(part.source)?.media ?? [] : []));
}

