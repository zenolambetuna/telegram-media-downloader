--- a/src/core/MediaPipeline.ts
+++ b/src/core/MediaPipeline.ts
@@ -11,6 +11,7 @@ import { CancellationToken } from '../queue/CancellationToken';
 import { logger } from '../logger/logger';
 import { config } from '../config/env';
 import { normalizeUrl } from '../utils/url';
+import path from 'node:path';
 
 export interface PipelineRequest {
   url: string;
@@ -90,6 +91,11 @@ export class MediaPipeline {
       const stored = await this.telegramStorage.upload(artifact);
       const deliveredMessageId = await this.telegramStorage.copy(request.chatId, stored.messageId);
       await this.counterRepository.increment('uploads');
+
+      // ⚠️ Clean up temp file ONLY after upload fully succeeds.
+      // Deleting before grammY sends the file causes "Upload failed after retries".
+      await this.telegramStorage.deleteTemp(artifact.filePath);
+
       return { messageId: deliveredMessageId, cached: false };
     } catch (error) {
       const appError = error instanceof AppError ? error : new AppError('Upload failed', 'UPLOAD_FAILED', error);
@@ -99,10 +105,9 @@ export class MediaPipeline {
           message: appError.message,
           context: JSON.stringify({ url: request.url, quality: request.quality }),
         });
+        logger.error({ error: appError, url: request.url, quality: request.quality }, 'Upload failed details');
       }
       throw appError;
-    } finally {
-      await this.telegramStorage.deleteTemp(artifact.filePath);
     }
   }
 }
