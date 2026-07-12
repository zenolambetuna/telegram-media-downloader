import { Context, SessionFlavor } from 'grammy';
import { MediaMetadata } from './media';

export interface SessionData {
  pendingUrl?: string;
  pendingMetadata?: MediaMetadata;
}

export type BotContext = Context & SessionFlavor<SessionData>;
