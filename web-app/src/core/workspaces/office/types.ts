import type { UserBrief } from './ui';

export type Kind = 'doc' | 'sheet' | 'deck';
export type Role = 'owner' | 'editor' | 'viewer';

export type BlockType = 'p' | 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'quote' | 'code' | 'divider' | 'todo' | 'image' | 'table';

export interface Block {
  id: string;
  type: BlockType;
  text: string;
  done?: boolean;
  lang?: string;
  url?: string;
  alt?: string;
  rows?: string[][];
  style?: Record<string, string | number | boolean>;
}

export interface DocData {
  blocks: Record<string, Block>;
  order: string[];
}

export interface Cell {
  v: string;
  style?: Record<string, string | number | boolean>;
}

export interface SheetData {
  cells: Record<string, Cell>;
  rows: number;
  cols: number;
  widths: Record<string, number>;
}

export type SlideLayout = 'title' | 'bullets' | 'text' | 'two' | 'image' | 'blank';

export interface Slide {
  id: string;
  layout: SlideLayout;
  title: string;
  body: string;
  bullets: string[];
  notes: string;
  image: string;
  style?: Record<string, string | number | boolean>;
}

export interface DeckData {
  slides: Record<string, Slide>;
  order: string[];
  theme: 'light' | 'dark' | 'ink' | 'sky';
}

export type Data = DocData | SheetData | DeckData;

export type Op =
  | { op: 'block.put'; block: Block; at?: number }
  | { op: 'block.del'; id: string }
  | { op: 'cell.set'; ref: string; cell: Cell }
  | { op: 'cell.clear'; ref: string }
  | { op: 'size'; rows?: number; cols?: number }
  | { op: 'width'; col: number; w: number }
  | { op: 'slide.put'; slide: Slide; at?: number }
  | { op: 'slide.del'; id: string }
  | { op: 'theme'; theme: DeckData['theme'] }
  | { op: 'order'; order: string[] };

export interface DocBrief {
  id: string;
  kind: Kind;
  title: string;
  role: Role;
  version: number;
  size: number;
  owner: UserBrief | null;
  created_at: string;
  updated_at: string;
}

export interface DocFull extends DocBrief {
  data: Data;
  members: (UserBrief & { role: Role })[];
}

export interface Revision {
  id: string;
  version: number;
  created_at: string;
  author: UserBrief | null;
}

export interface Comment {
  id: string;
  anchor: string;
  text: string;
  resolved: boolean;
  author: UserBrief;
  created_at: string;
}

export const emptyData = (kind: Kind): Data =>
  kind === 'sheet' ? { cells: {}, rows: 50, cols: 12, widths: {} }
    : kind === 'deck' ? { slides: {}, order: [], theme: 'light' }
      : { blocks: {}, order: [] };

export const uid = () => Math.random().toString(36).slice(2, 10);
