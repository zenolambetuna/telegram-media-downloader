import { Context, SessionFlavor } from 'grammy';
import { ResolvedMediaInfo } from './media';
import { MediaPipeline } from '../core/MediaPipeline';

export interface SessionData {
  pendingUrl?: string;
  /** The full ResolvedMediaInfo from FormatResolver */
  pendingInfo?: ResolvedMediaInfo;
}

export interface BotContextFlavor {
  pipeline: MediaPipeline;
}

export type BotContext = Context & SessionFlavor<SessionData> & BotContextFlavor;
