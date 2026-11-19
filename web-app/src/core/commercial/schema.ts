export type Scalar = string | number | boolean | null;
export type ServiceField = { id: string; label: string; kind: 'text' | 'password' | 'number' | 'checkbox' | 'select'; required?: boolean; options?: string[] };
export type ServiceNode =
  | { kind: 'workspace'; id: string }
  | { kind: 'text'; text: string }
  | { kind: 'section'; title: string; nodes: ServiceNode[] }
  | { kind: 'table'; columns: string[]; rows: Scalar[][] }
  | { kind: 'form'; id: string; action: string; label: string; fields: ServiceField[] };
export type ServiceDocument = { schema: 'sfera-ui/v1'; title: string; nodes: ServiceNode[] };
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
function invalid(): never { throw new Error('invalid_commercial_document'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function text(value: unknown, max = 4000): asserts value is string {
  if (typeof value !== 'string' || value.length > max) invalid();
}
function id(value: unknown) {
  text(value, 64);
  if (!ID.test(value) || reserved.has(value)) invalid();
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value;
}
/** Pure data only: no executable nodes, HTML, URLs, bindings or styles. */
export function parseServiceDocument(input: unknown): ServiceDocument {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(input); } catch { return invalid(); }
  if (!encoded || new TextEncoder().encode(encoded).length > 262144) invalid();
  const document = record(input);
  keys(document, ['schema', 'title', 'nodes']);
  if (document.schema !== 'sfera-ui/v1') invalid();
  text(document.title, 200);
  let budget = 200;
  const forms = new Set<string>();
  const visit = (input: unknown, depth: number) => {
    if (--budget < 0 || depth > 6) invalid();
    const node = record(input);
    switch (node.kind) {
      case 'workspace':
        keys(node, ['kind', 'id']);
        if (typeof node.id !== 'string' || !['office', 'whiteboard', 'planner', 'conference', 'servers', 'channels', 'bots', 'diary', 'family', 'legal', 'multiserver', 'totp'].includes(node.id)) invalid();
        break;
      case 'text': keys(node, ['kind', 'text']); text(node.text); break;
      case 'section':
        keys(node, ['kind', 'title', 'nodes']); text(node.title, 200);
        list(node.nodes, 100).forEach(child => visit(child, depth + 1)); break;
      case 'table': {
        keys(node, ['kind', 'columns', 'rows']);
        const columns = list(node.columns, 20);
        if (!columns.length) invalid();
        columns.forEach(column => text(column, 100));
        list(node.rows, 200).forEach(row => {
          const values = list(row, 20);
          if (values.length !== columns.length) invalid();
          values.forEach(value => {
            if (typeof value === 'string') text(value);
            else if (value !== null && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) invalid();
          });
        }); break;
      }
      case 'form': {
        keys(node, ['kind', 'id', 'action', 'label', 'fields']); id(node.id); id(node.action); text(node.label, 100);
        if (forms.has(node.id as string)) invalid();
        forms.add(node.id as string);
        const fields = new Set<string>();
        list(node.fields, 30).forEach(input => {
          const field = record(input);
          keys(field, ['id', 'label', 'kind', 'required', 'options']); id(field.id); text(field.label, 200);
          if (fields.has(field.id as string)) invalid();
          fields.add(field.id as string);
          if (typeof field.kind !== 'string' || !['text', 'password', 'number', 'checkbox', 'select'].includes(field.kind)) invalid();
          if (field.required !== undefined && typeof field.required !== 'boolean') invalid();
          if (field.kind === 'select') {
            const options = list(field.options, 100);
            if (!options.length) invalid();
            options.forEach(option => text(option, 200));
          } else if (field.options !== undefined) invalid();
        }); break;
      }
      default: invalid();
    }
  };
  list(document.nodes, 100).forEach(node => visit(node, 0));
  return input as ServiceDocument;
}

export type CommercialService = { id: string; name: Record<string, string>; paid: true; scope: 'instance'; delivery: 'declarative'; migrated?: boolean; available: boolean; installed?: boolean; subscription: { status: 'active' | 'expired' | 'required' | 'paused' | 'revoked'; expires_at: string | null } };
export function parseServiceCatalog(input: unknown): CommercialService[] {
  const catalog = record(input);
  keys(catalog, ['instance_id', 'modules']); text(catalog.instance_id, 64);
  const ids = new Set<string>();
  list(catalog.modules, 100).forEach(input => {
    const service = record(input);
    keys(service, ['id', 'name', 'paid', 'scope', 'delivery', 'migrated', 'available', 'installed', 'subscription']);
    if (service.migrated !== undefined && typeof service.migrated !== 'boolean') invalid();
    id(service.id);
    if (ids.has(service.id as string)) invalid();
    ids.add(service.id as string);
    if (service.paid !== true || service.scope !== 'instance' || service.delivery !== 'declarative' || typeof service.available !== 'boolean') invalid();
    const names = record(service.name);
    if (!Object.keys(names).length || Object.keys(names).length > 20) invalid();
    Object.entries(names).forEach(([locale, name]) => { if (!/^[a-z]{2}$/.test(locale)) invalid(); text(name, 200); });
    const sub = record(service.subscription);
    keys(sub, ['status', 'expires_at']);
    if (typeof sub.status !== 'string' || !['active', 'expired', 'required', 'paused', 'revoked'].includes(sub.status)) invalid();
    if (sub.expires_at !== null) {
      text(sub.expires_at, 64);
      if (!Number.isFinite(Date.parse(sub.expires_at))) invalid();
    }
    if (service.available && sub.status !== 'active') invalid();
    if (service.installed !== undefined && typeof service.installed !== 'boolean') invalid();
    if (service.installed === true && !service.available) invalid();
  });
  return catalog.modules as CommercialService[];
}
