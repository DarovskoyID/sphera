import React from 'react';

/**
 * Loading placeholders.
 *
 * A spinner says "something is happening"; a skeleton says what is about to
 * appear and where. It also keeps the layout from jumping when the real
 * content lands, which is most of what makes a slow load feel slow.
 *
 * Styles live in styles/skeleton.css so the shimmer can be switched off in one
 * place for readers who asked for reduced motion.
 */

export const Skeleton: React.FC<{
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: React.CSSProperties;
}> = ({ width, height = 12, radius = 6, className, style }) => (
  <span
    className={`skeleton${className ? ` ${className}` : ''}`}
    style={{ width, height, borderRadius: radius, ...style }}
  />
);

export const SkeletonCircle: React.FC<{ size: number; style?: React.CSSProperties }> = ({ size, style }) => (
  <Skeleton width={size} height={size} radius="50%" style={style} />
);

/**
 * A conversation being opened.
 *
 * The bubbles alternate sides and vary in width, because a column of identical
 * grey rectangles reads as a broken page rather than as loading. The widths are
 * fixed rather than random so the skeleton does not reshuffle on every render.
 */
const BUBBLES: Array<{ own: boolean; width: number; lines: number }> = [
  { own: false, width: 62, lines: 2 },
  { own: true, width: 44, lines: 1 },
  { own: false, width: 38, lines: 1 },
  { own: true, width: 70, lines: 2 },
  { own: false, width: 52, lines: 1 },
  { own: false, width: 34, lines: 1 },
  { own: true, width: 58, lines: 1 },
];

export const MessageListSkeleton: React.FC = () => (
  <div className="skeleton-messages" aria-hidden="true">
    {BUBBLES.map((b, i) => (
      <div key={i} className={`skeleton-bubble-row${b.own ? ' is-own' : ''}`}>
        {!b.own && <SkeletonCircle size={34} style={{ flex: 'none' }} />}
        <div className="skeleton-bubble" style={{ width: `${b.width}%` }}>
          {Array.from({ length: b.lines }, (_, line) => (
            <Skeleton
              key={line}
              height={10}
              width={line === b.lines - 1 ? '72%' : '100%'}
            />
          ))}
        </div>
      </div>
    ))}
  </div>
);

export default Skeleton;
