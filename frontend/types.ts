import type { UserBrief } from './ui';

export type Role = 'owner' | 'editor' | 'viewer';

export type BoxType = 'rect' | 'ellipse' | 'diamond' | 'triangle' | 'hexagon' | 'cylinder' | 'cloud' | 'note' | 'text' | 'frame';
export type ShapeType = BoxType | 'line' | 'pen';
export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface Style {
  fill: string;
  stroke: string;
  strokeWidth: number;
  dash: 'solid' | 'dashed' | 'dotted';
  opacity: number;
  fontSize: number;
  textColor: string;
  align: 'left' | 'center' | 'right';
  vAlign: 'top' | 'middle' | 'bottom';
  bold: boolean;
  radius: number;
}

export interface BoxShape {
  id: string;
  type: BoxType;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  style: Style;
  locked?: boolean;
}

export interface EndPoint {
  x: number;
  y: number;
  /** Attached to a shape: the end follows it. */
  shapeId?: string;
  side?: Side | 'auto';
}

export interface LineShape {
  id: string;
  type: 'line';
  from: EndPoint;
  to: EndPoint;
  route: 'straight' | 'orthogonal' | 'curved';
  arrowStart: 'none' | 'arrow' | 'triangle' | 'circle' | 'diamond';
  arrowEnd: 'none' | 'arrow' | 'triangle' | 'circle' | 'diamond';
  text: string;
  style: Style;
  locked?: boolean;
}

export interface PenShape {
  id: string;
  type: 'pen';
  points: number[];
  style: Style;
  locked?: boolean;
}

export type Shape = BoxShape | LineShape | PenShape;

export interface Doc {
  shapes: Record<string, Shape>;
  order: string[];
}

export type Op = { op: 'put'; shape: Shape } | { op: 'del'; id: string } | { op: 'order'; order: string[] };

export interface BoardBrief {
  id: string;
  name: string;
  role: Role;
  version: number;
  shapes: number;
  created_at: string;
  updated_at: string;
}

export interface Board extends BoardBrief {
  doc: Doc;
  members: (UserBrief & { role: Role })[];
}

export type Tool = 'select' | 'hand' | BoxType | 'line' | 'pen';

export const DEFAULT_STYLE: Style = {
  fill: '#ffffff', stroke: '#1f2937', strokeWidth: 2, dash: 'solid', opacity: 1,
  fontSize: 16, textColor: '#111827', align: 'center', vAlign: 'middle', bold: false, radius: 8,
};

/** Palette tuned to read well on both the light and the dark canvas. */
export const FILLS = ['transparent', '#ffffff', '#f1f5f9', '#fee2e2', '#ffedd5', '#fef9c3', '#dcfce7', '#cffafe', '#dbeafe', '#ede9fe', '#fce7f3', '#1f2937'];
export const STROKES = ['#1f2937', '#64748b', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#ffffff'];
export const NOTE_FILLS = ['#fef08a', '#fbcfe8', '#bbf7d0', '#bae6fd', '#ddd6fe', '#fed7aa'];
