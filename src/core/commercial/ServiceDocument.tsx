import { useState } from 'react';
import { parseServiceDocument, type ServiceDocument, type ServiceNode, type Scalar } from './schema';

type Messages = { invalid: string; failed: string; pending: string };
type Action = (action: string, values: Record<string, Scalar>) => Promise<void>;
function Form({ node, onAction, messages }: { node: Extract<ServiceNode, { kind: 'form' }>; onAction: Action; messages: Messages }) {
  const [values, setValues] = useState<Record<string, Scalar>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <form onSubmit={event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setFailed(false);
    void onAction(node.action, values).catch(() => setFailed(true)).finally(() => setBusy(false));
  }}>
    {node.fields.map(field => <label key={field.id} style={{ display: 'block', marginBottom: 12 }}>
      <span>{field.label}</span>
      {field.kind === 'select' ? <select required={field.required} value={String(values[field.id] ?? '')} onChange={event => setValues(previous => ({ ...previous, [field.id]: event.target.value }))}>
        <option value="" />{field.options?.map(option => <option key={option} value={option}>{option}</option>)}
      </select> : <input type={field.kind === 'checkbox' ? 'checkbox' : field.kind} required={field.required}
        checked={field.kind === 'checkbox' ? values[field.id] === true : undefined}
        value={field.kind === 'checkbox' ? undefined : String(values[field.id] ?? '')}
        onChange={event => setValues(previous => ({ ...previous, [field.id]: field.kind === 'checkbox' ? event.target.checked : field.kind === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value }))} />}
    </label>)}
    <button type="submit" disabled={busy}>{busy ? messages.pending : node.label}</button>
    {failed && <p role="alert">{messages.failed}</p>}
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
