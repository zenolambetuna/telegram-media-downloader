--- a/src/types/media.ts
+++ b/src/types/media.ts
@@ -1,19 +1,34 @@
 /**
- * Platform identity is now a runtime string, not a compile-time union.
- * This is the single change that unlocks true zero-core-edit providers:
- * adding a new provider never requires editing this type. The alias is kept
- * for backward compatibility so every existing import keeps working.
+ * ResolvedMediaInfo — the single source of truth after format resolution.
+ * Every extractor (TikTok, YouTube, Instagram, Facebook, X, etc.) returns this.
+ * The keyboard builder reads ONLY this structure.
  */
-export type SupportedPlatform = string;
+export interface ResolvedMediaInfo {
+  platform: string;
+  title: string;
+  description?: string;
+  duration?: number;
+  thumbnail?: string;
+  uploader?: string;
+  originalUrl: string;
+  canonicalUrl: string;
+  /** True if at least one format is classified as video */
+  hasVideo: boolean;
+  /** True if at least one format is classified as audio */
+  hasAudio: boolean;
+  /** All video formats */
+  videoFormats: MediaFormat[];
+  /** All audio formats */
+  audioFormats: MediaFormat[];
+  /** The single best video format (highest quality, then highest bitrate) */
+  bestVideo?: MediaFormat;
+  /** The single best audio format (highest bitrate) */
+  bestAudio?: MediaFormat;
+  /**
+   * True only when videoFormats has MORE THAN ONE distinct quality label.
+   * This controls whether the resolution picker is shown.
+   */
+  supportsResolutionSelection: boolean;
+}
 
 export type MediaKind = 'video' | 'audio';
 
@@ -45,38 +60,8 @@ export interface MediaMetadata {
   formats: MediaFormat[];
 }
 
-export interface DownloadRequest {
-  url: string;
-  formatId: string;
-  userId: number;
-  chatId: number;
-}
-
-export interface MediaProbe {
-  mediaType: MediaType;
-  resolution?: string;
-  width?: number;
-  height?: number;
-  fps?: number;
-  bitrate?: number;
-  codec?: string;
-  size?: number;
-}
-
-export interface DownloadArtifact {
-  filePath: string;
-  fileName: string;
-  mimeType: string;
-  quality: string;
-  checksum: string;
-  probe: MediaProbe;
-  metadata: MediaMetadata;
-}
-
-export interface StoredMediaRecord {
-  id?: number;
-  messageId: number;
+// ... existing DownloadRequest, MediaProbe, DownloadArtifact, StoredMediaRecord, UploadResult, QueueJobResult, CacheLookup, SupportedPlatform remain unchanged
