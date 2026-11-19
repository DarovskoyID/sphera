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

/**
 * Rows of avatar + two lines: friend lists, member lists, blocked users,
 * devices, roles, invites — anything that loads as a list of people or items.
 */
export const ListSkeleton: React.FC<{ rows?: number; avatar?: boolean; avatarSize?: number }> = ({
  rows = 6, avatar = true, avatarSize = 34,
}) => (
  <div className="skeleton-list" aria-hidden="true">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="skeleton-row">
        {avatar && <SkeletonCircle size={avatarSize} />}
        <span className="skeleton-row-text">
          {/* Varying widths so the column does not read as a striped block. */}
          <Skeleton height={11} width={`${52 + ((i * 13) % 34)}%`} />
          <Skeleton height={9} width={`${28 + ((i * 17) % 26)}%`} />
        </span>
      </div>
    ))}
  </div>
);

/** The Explore grid, and anything else that loads as a grid of cards. */
export const CardGridSkeleton: React.FC<{ cards?: number }> = ({ cards = 6 }) => (
  <div className="skeleton-cards" aria-hidden="true">
    {Array.from({ length: cards }, (_, i) => (
      <div key={i} className="skeleton-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SkeletonCircle size={38} />
          <span className="skeleton-row-text">
            <Skeleton height={11} width={`${58 + ((i * 11) % 30)}%`} />
            <Skeleton height={9} width="40%" />
          </span>
        </div>
        <Skeleton height={9} width="100%" />
        <Skeleton height={9} width={`${54 + ((i * 19) % 32)}%`} />
      </div>
    ))}
  </div>
);

/**
 * Stands in for a photo or video while its bytes are fetched.
 *
 * Attachments are downloaded with an Authorization header and turned into a
 * blob, so there is a real gap before anything can be shown. Giving the
 * placeholder the media's own dimensions is what stops the message list
 * jumping when it resolves.
 */
export const MediaSkeleton: React.FC<{ width?: number | string; height?: number | string }> = ({
  width = 240, height = 160,
}) => <Skeleton width={width} height={height} radius={10} style={{ marginTop: 4, maxWidth: '100%' }} />;

/** A feed of posts: author line, some text, and a wide media block. */
export const FeedSkeleton: React.FC<{ posts?: number }> = ({ posts = 3 }) => (
  <div className="skeleton-feed" aria-hidden="true">
    {Array.from({ length: posts }, (_, i) => (
      <div key={i} className="skeleton-post">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SkeletonCircle size={40} />
          <span className="skeleton-row-text">
            <Skeleton height={11} width="34%" />
            <Skeleton height={9} width="18%" />
          </span>
        </div>
        <Skeleton height={10} width="100%" />
        <Skeleton height={10} width={`${46 + ((i * 23) % 40)}%`} />
        {i % 2 === 0 && <Skeleton height={180} radius={12} width="100%" />}
      </div>
    ))}
  </div>
);

export default Skeleton;
