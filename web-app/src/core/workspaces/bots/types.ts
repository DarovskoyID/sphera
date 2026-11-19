// Bot module types.

export interface BotCommand {
  command: string;
  description: string;
}

export interface BotAccount {
  id: string;
  user_id: string;
  username: string;
  display_name: string;
  description: string;
  avatar: string;
  commands: BotCommand[];
  token_prefix: string;
  is_active: boolean;
  is_system: boolean;
  created_at: string;
  owner_id: string;
  /** Present exactly once, in the response that issues a new key. */
  token?: string;
}

/** A bot reachable from the current composer, with the commands it exposes. */
export interface ChatBot {
  user_id: string;
  username: string;
  display_name: string;
  avatar: string;
  commands: BotCommand[];
}
