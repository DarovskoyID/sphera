import { useRef, useState } from 'react';
import { parseServiceDocument, type ServiceDocument, type ServiceNode, type Scalar } from './schema';

type Messages = { invalid: string; failed: string; pending: string };
type Action = (action: string, values: Record<string, Scalar>, requestId: string) => Promise<void>;
function newRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function Form({ node, onAction, messages }: { node: Extract<ServiceNode, { kind: 'form' }>; onAction: Action; messages: Messages }) {
  const [values, setValues] = useState<Record<string, Scalar>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const inFlight = useRef(false);
  const requestId = useRef<string | null>(null);
  const change = (id: string, value: Scalar) => { requestId.current = null; setValues(previous => ({ ...previous, [id]: value })); };
  return <form onSubmit={event => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    requestId.current ??= newRequestId();
    setBusy(true); setFailed(null);
    void onAction(node.action, values, requestId.current).catch(error => {
      const detail = (error as { userMessage?: unknown } | null)?.userMessage;
      setFailed(typeof detail === 'string' ? detail : messages.failed);
    }).finally(() => { inFlight.current = false; setBusy(false); });
  }}>
    {node.fields.map(field => <label key={field.id} style={{ display: 'block', marginBottom: 12 }}>
      <span>{field.label}</span>
      {field.kind === 'select' ? <select disabled={busy} required={field.required} value={String(values[field.id] ?? '')} onChange={event => change(field.id, event.target.value)}>
        <option value="" />{field.options?.map(option => <option key={option} value={option}>{option}</option>)}
      </select> : <input disabled={busy} autoComplete={field.kind === 'password' ? 'new-password' : undefined} maxLength={field.kind === 'password' || field.kind === 'text' ? 4000 : undefined} type={field.kind === 'checkbox' ? 'checkbox' : field.kind} required={field.required}
        checked={field.kind === 'checkbox' ? values[field.id] === true : undefined}
        value={field.kind === 'checkbox' ? undefined : String(values[field.id] ?? '')}
        onChange={event => change(field.id, field.kind === 'checkbox' ? event.target.checked : field.kind === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)} />}
    </label>)}
    <button type="submit" disabled={busy}>{busy ? messages.pending : node.label}</button>
    {failed && <p role="alert">{failed}</p>}
  </form>;
}
function Nodes({ nodes, onAction, messages }: { nodes: ServiceNode[]; onAction: Action; messages: Messages }) {
  return <>{nodes.map((node, index) => {
    switch (node.kind) {
      case 'text': return <p key={index}>{node.text}</p>;
      case 'section': return <section key={index}><h3>{node.title}</h3><Nodes nodes={node.nodes} onAction={onAction} messages={messages} /></section>;
      case 'table': return <div key={index} style={{ overflowX: 'auto' }}><table><thead><tr>{node.columns.map((column, i) => <th key={i}>{column}</th>)}</tr></thead><tbody>{node.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell === null ? '' : String(cell)}</td>)}</tr>)}</tbody></table></div>;
      case 'form': return <Form key={node.id} node={node} onAction={onAction} messages={messages} />;
    }
  })}</>;
}
/** The host supplies the authenticated action transport; the document cannot choose a URL. */
export function CommercialDocument({ document, onAction, messages }: { document: unknown; onAction: Action; messages: Messages }) {
  let validated: ServiceDocument;
  try { validated = parseServiceDocument(document); } catch { return <p role="alert">{messages.invalid}</p>; }
  return <article><h2>{validated.title}</h2><Nodes nodes={validated.nodes} onAction={onAction} messages={messages} /></article>;
}
