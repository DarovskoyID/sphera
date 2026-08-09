// Bot identity markers.
//
// A bot is visible in two independent ways, so neither can be missed: the
// account name always carries the `_bot` suffix (enforced server-side at
// registration, restored here for anything that arrived without it), and a
// small BOT chip sits next to the name wherever people read names.

import React from 'react';
import type { AccountType } from '../types';

export const BOT_SUFFIX = '_bot';

interface AccountLike {
  account_type?: AccountType | string;
  username?: string;
}

export const isBot = (account?: AccountLike | null): boolean =>
  !!account && (
    account.account_type === 'bot'
    || (!!account.username && account.username.endsWith(BOT_SUFFIX))
  );

export const isAdminAccount = (account?: AccountLike | null): boolean =>
  account?.account_type === 'admin';

/** Display name for a bot: a nickname stays readable, but `_bot` is always shown. */
export function botName(nickname: string | undefined, username: string | undefined): string {
  const base = (nickname || username || '?').trim();
  if (base.toLowerCase().endsWith(BOT_SUFFIX)) return base;
  return `${base}${BOT_SUFFIX}`;
}

/** Name to render for any account — bots get the suffix, everyone else doesn't. */
export function accountDisplayName(account?: AccountLike & { nickname?: string } | null): string {
  if (!account) return '?';
  return isBot(account)
    ? botName(account.nickname, account.username)
    : (account.nickname || account.username || '?');
}

export const BotBadge: React.FC<{ size?: 'sm' | 'md' }> = ({ size = 'sm' }) => (
  <span
    title="Бот"
    style={{
      display: 'inline-flex', alignItems: 'center', flexShrink: 0,
      padding: size === 'sm' ? '0 4px' : '1px 6px',
      marginLeft: 5,
      borderRadius: 4,
      background: 'linear-gradient(135deg,#5865f2,#7c3aed)',
      color: '#fff',
      fontSize: size === 'sm' ? 9 : 10,
      fontWeight: 800,
      letterSpacing: '0.6px',
      lineHeight: size === 'sm' ? '14px' : '16px',
      textTransform: 'uppercase',
      verticalAlign: 'middle',
    }}
  >
    BOT
  </span>
);

export const AdminBadge: React.FC<{ size?: 'sm' | 'md' }> = ({ size = 'sm' }) => (
  <span
    title="Администратор Сферы"
    style={{
      display: 'inline-flex', alignItems: 'center', flexShrink: 0,
      padding: size === 'sm' ? '0 4px' : '1px 6px',
      marginLeft: 5,
      borderRadius: 4,
      background: 'linear-gradient(135deg,#f59e0b,#ef4444)',
      color: '#fff',
      fontSize: size === 'sm' ? 9 : 10,
      fontWeight: 800,
      letterSpacing: '0.6px',
      lineHeight: size === 'sm' ? '14px' : '16px',
      textTransform: 'uppercase',
      verticalAlign: 'middle',
    }}
  >
    ADMIN
  </span>
);

/** The badge that matches an account's global role, or nothing for plain users. */
export const AccountBadge: React.FC<{ account?: AccountLike | null; size?: 'sm' | 'md' }> = ({ account, size }) => {
  if (isBot(account)) return <BotBadge size={size} />;
  if (isAdminAccount(account)) return <AdminBadge size={size} />;
  return null;
};
