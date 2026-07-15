--- a/src/types/bot.ts
+++ b/src/types/bot.ts
@@ -1,10 +1,15 @@
 import { Context, SessionFlavor } from 'grammy';
-import { MediaMetadata } from './media';
+import { ResolvedMediaInfo } from './media';
 import { MediaPipeline } from '../core/MediaPipeline';
 
 export interface SessionData {
   pendingUrl?: string;
-  pendingMetadata?: MediaMetadata;
+  /** The full ResolvedMediaInfo from FormatResolver */
+  pendingInfo?: ResolvedMediaInfo;
 }
 
-export type BotContext = Context & SessionFlavor<SessionData>;
+export interface BotContextFlavor {
+  pipeline: MediaPipeline;
+}
+
+export type BotContext = Context & SessionFlavor<SessionData> & BotContextFlavor;
