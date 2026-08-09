// The node-graph model shared by the editor and the code generators.

export type BotNodeType =
  | 'trigger_command'
  | 'trigger_message'
  | 'reply'
  | 'condition'
  | 'http_get'
  | 'delay'
  | 'stop';

export interface BotNode {
  id: string;
  type: BotNodeType;
  x: number;
  y: number;
  data: Record<string, string>;
}

/** `port` is 'out' for linear nodes, 'then' / 'else' for a condition. */
export interface BotEdge {
  id: string;
  from: string;
  port: 'out' | 'then' | 'else';
  to: string;
}

export interface BotGraph {
  nodes: BotNode[];
  edges: BotEdge[];
}

export const EMPTY_GRAPH: BotGraph = { nodes: [], edges: [] };

interface FieldSpec {
  key: string;
  label: string;
  labelEn: string;
  placeholder?: string;
  multiline?: boolean;
}

export interface NodeSpec {
  type: BotNodeType;
  title: string;
  titleEn: string;
  hint: string;
  hintEn: string;
  color: string;
  isTrigger: boolean;
  ports: ('out' | 'then' | 'else')[];
  fields: FieldSpec[];
}

export const NODE_SPECS: NodeSpec[] = [
  {
    type: 'trigger_command',
    title: 'Команда',
    titleEn: 'Command',
    hint: 'Срабатывает на /команду. Попадает в кнопку команд у поля ввода.',
    hintEn: 'Fires on /command. Shows up in the command button by the composer.',
    color: '#5865f2',
    isTrigger: true,
    ports: ['out'],
    fields: [
      { key: 'command', label: 'Команда (без «/»)', labelEn: 'Command (no "/")', placeholder: 'start' },
      { key: 'description', label: 'Описание', labelEn: 'Description', placeholder: 'Запустить бота' },
    ],
  },
  {
    type: 'trigger_message',
    title: 'Сообщение',
    titleEn: 'Message',
    hint: 'Срабатывает на обычное сообщение. Пусто — на любое.',
    hintEn: 'Fires on a plain message. Empty means any message.',
    color: '#3ba55d',
    isTrigger: true,
    ports: ['out'],
    fields: [{ key: 'contains', label: 'Содержит текст', labelEn: 'Contains text', placeholder: 'привет' }],
  },
  {
    type: 'reply',
    title: 'Ответить',
    titleEn: 'Reply',
    hint: 'Отправляет текст в тот же чат. Подстановки: {text}, {args}, {user}.',
    hintEn: 'Sends text into the same chat. Placeholders: {text}, {args}, {user}.',
    color: '#eb459e',
    isTrigger: false,
    ports: ['out'],
    fields: [{ key: 'text', label: 'Текст', labelEn: 'Text', placeholder: 'Привет, {user}!', multiline: true }],
  },
  {
    type: 'condition',
    title: 'Условие',
    titleEn: 'Condition',
    hint: 'Если текст сообщения содержит значение — ветка «да», иначе «нет».',
    hintEn: 'If the message text contains the value, take the "yes" branch, else "no".',
    color: '#faa81a',
    isTrigger: false,
    ports: ['then', 'else'],
    fields: [{ key: 'value', label: 'Текст содержит', labelEn: 'Text contains', placeholder: 'погода' }],
  },
  {
    type: 'http_get',
    title: 'HTTP-запрос',
    titleEn: 'HTTP request',
    hint: 'GET-запрос. Ответ кладётся в переменную, доступную как {имя}.',
    hintEn: 'GET request. The response goes into a variable, usable as {name}.',
    color: '#00a8fc',
    isTrigger: false,
    ports: ['out'],
    fields: [
      { key: 'url', label: 'URL', labelEn: 'URL', placeholder: 'https://example.com/api' },
      { key: 'var', label: 'Переменная', labelEn: 'Variable', placeholder: 'result' },
    ],
  },
  {
    type: 'delay',
    title: 'Пауза',
    titleEn: 'Delay',
    hint: 'Ждёт перед следующим шагом.',
    hintEn: 'Waits before the next step.',
    color: '#949cf7',
    isTrigger: false,
    ports: ['out'],
    fields: [{ key: 'seconds', label: 'Секунды', labelEn: 'Seconds', placeholder: '1' }],
  },
  {
    type: 'stop',
    title: 'Стоп',
    titleEn: 'Stop',
    hint: 'Завершает обработку.',
    hintEn: 'Ends the handler.',
    color: '#ed4245',
    isTrigger: false,
    ports: [],
    fields: [],
  },
];

export const specFor = (type: BotNodeType): NodeSpec =>
  NODE_SPECS.find(s => s.type === type) || NODE_SPECS[0];

export const nextNode = (graph: BotGraph, id: string, port: 'out' | 'then' | 'else') => {
  const edge = graph.edges.find(e => e.from === id && e.port === port);
  return edge ? graph.nodes.find(n => n.id === edge.to) : undefined;
};

/** Commands the graph declares — what gets registered for the command button. */
export function graphCommands(graph: BotGraph) {
  const seen = new Set<string>();
  const commands: { command: string; description: string }[] = [];
  for (const node of graph.nodes) {
    if (node.type !== 'trigger_command') continue;
    const command = (node.data.command || '').trim().replace(/^\//, '').toLowerCase();
    if (!command || seen.has(command)) continue;
    seen.add(command);
    commands.push({ command, description: (node.data.description || '').trim() });
  }
  return commands;
}

/** Problems worth surfacing before an export. */
export function validateGraph(graph: BotGraph, isRu = true): string[] {
  const t = (ru: string, en: string) => (isRu ? ru : en);
  const problems: string[] = [];
  const triggers = graph.nodes.filter(n => specFor(n.type).isTrigger);
  if (triggers.length === 0) {
    problems.push(t(
      'Нужен хотя бы один узел-триггер («Команда» или «Сообщение»).',
      'At least one trigger node is required ("Command" or "Message").',
    ));
  }
  for (const node of graph.nodes) {
    if (node.type === 'trigger_command' && !(node.data.command || '').trim()) {
      problems.push(t('У узла «Команда» не заполнено имя команды.', 'A "Command" node has no command name.'));
    }
    if (node.type === 'reply' && !(node.data.text || '').trim()) {
      problems.push(t('У узла «Ответить» пустой текст.', 'A "Reply" node has empty text.'));
    }
    if (node.type === 'http_get' && !(node.data.url || '').trim()) {
      problems.push(t('У узла «HTTP-запрос» не указан URL.', 'An "HTTP request" node has no URL.'));
    }
  }
  const reachable = new Set<string>();
  const walk = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    graph.edges.filter(e => e.from === id).forEach(e => walk(e.to));
  };
  triggers.forEach(trigger => walk(trigger.id));
  const orphans = graph.nodes.filter(n => !reachable.has(n.id));
  if (orphans.length) {
    problems.push(t(
      `Узлы не подключены к триггеру: ${orphans.length}. Они не попадут в код.`,
      `${orphans.length} node(s) are not reachable from a trigger and won't reach the code.`,
    ));
  }
  return [...new Set(problems)];
}
