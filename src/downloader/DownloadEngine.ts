--- a/src/downloader/DownloadEngine.ts
+++ b/src/downloader/DownloadEngine.ts
@@ -1,17 +1,15 @@
 import path from 'node:path';
 import { randomUUID } from 'node:crypto';
 import { config } from '../config/env';
 import { logger } from '../logger/logger';
 import { AppError } from '../types/errors';
 import {
   EngineDownloadRequest,
   EngineDownloadResult,
-  EngineMetadata,
   NormalizedFormat,
 } from '../types/download';
-import { MediaProbe, SupportedPlatform } from '../types/media';
+import { MediaProbe, ResolvedMediaInfo } from '../types/media';
 import { assertValidUrl } from '../utils/url';
 import { withRetry } from '../utils/retry';
 import { resolveMediaType } from '../telegram/mediaType';
@@ -29,16 +27,16 @@ import { YtDlpClient } from './YtDlpClient';
 export class DownloadEngine {
   constructor(
     private readonly metadataService: MetadataService,
     private readonly ytDlpClient: YtDlpClient,
     private readonly ffmpegService: FFmpegService,
     private readonly checksumService: ChecksumService,
     private readonly tempFileManager: TempFileManager,
   ) {}
 
-  async inspect(url: string, provider: SupportedPlatform): Promise<EngineMetadata> {
+  async inspect(url: string, provider: string): Promise<ResolvedMediaInfo> {
     assertValidUrl(url);
-    const result = await this.metadataService.fetch(url, provider);
-    if (result.isLive) {
-      throw new AppError('Live streams are not downloadable yet', 'LIVE_STREAM');
-    }
-    return result;
+    return await this.metadataService.fetch(url, provider);
   }
 
   async download(request: EngineDownloadRequest): Promise<EngineDownloadResult> {
@@ -54,10 +52,21 @@ export class DownloadEngine {
     try {
       tracker.setStage('fetching_metadata');
-      const inspected = await this.inspect(request.url, request.provider);
+      const info: ResolvedMediaInfo = await this.inspect(request.url, request.provider);
 
       tracker.setStage('resolving_formats');
-      const format = this.selectFormat(inspected.formats, request.formatId);
+      // Find the selected format from all formats
+      const allFormats = [...info.videoFormats, ...info.audioFormats];
+      const format = this.selectFormat(allFormats as any, request.formatId);
+      const nf = this.toNormalized(format as any);
 
       tracker.setStage('downloading');
-      const mediaPath = await this.acquireMedia(request, inspected.formats, format, workspace, tracker);
+      const mediaPath = await this.acquireMedia(request, allFormats as any, format as any, workspace, tracker);
 
       tracker.setStage('processing');
       const thumbnailPath = await this.ffmpegService.extractThumbnail(mediaPath, workspace);
 
       const checksum = await this.checksumService.generate(mediaPath);
-      const mimeType = this.resolveMimeType(format);
-      const probe = this.buildProbe(format, mimeType, inspected.metadata.duration);
+      const mimeType = this.resolveMimeType(format as any);
+      const probe = this.buildProbe(nf, mimeType, info.duration);
 
       tracker.setStage('finished');
 
@@ -68,7 +77,17 @@ export class DownloadEngine {
         quality: format.quality,
         checksum,
         probe,
-        metadata: inspected.metadata,
+        metadata: {
+          id: info.canonicalUrl || 'unknown',
+          provider: info.platform,
+          originalUrl: info.originalUrl,
+          canonicalUrl: info.canonicalUrl,
+          title: info.title,
+          description: info.description,
+          duration: info.duration,
+          thumbnail: info.thumbnail,
+          uploader: info.uploader,
+          filesize: format.filesize,
+          formats: allFormats,
+        },
         thumbnailPath,
       };
     } catch (error) {
@@ -83,7 +102,7 @@ export class DownloadEngine {
     return await this.tempFileManager.recoverOrphans(6 * 60 * 60 * 1000);
   }
 
-  private selectFormat(formats: NormalizedFormat[], formatId: string): NormalizedFormat {
+  private selectFormat(formats: { id: string; kind: string }[], formatId: string): { id: string; kind: string; quality: string; filesize?: number; extension?: string; width?: number; height?: number; fps?: number; bitrate?: number; hasVideo?: boolean; hasAudio?: boolean } {
     const format = formats.find((item) => item.id === formatId);
     if (!format) {
       throw new AppError('Requested format is not available', 'UNSUPPORTED_FORMAT');
@@ -93,55 +112,62 @@ export class DownloadEngine {
 
   private async acquireMedia(
     request: EngineDownloadRequest,
-    formats: NormalizedFormat[],
-    format: NormalizedFormat,
+    formats: { id: string; kind: string; quality: string; hasVideo?: boolean; hasAudio?: boolean; extension?: string }[],
+    format: { id: string; kind: string; quality: string; hasVideo?: boolean; hasAudio?: boolean; extension?: string },
     workspace: string,
     tracker: ProgressTracker,
   ): Promise<string> {
     const download = (formatId: string): Promise<string> =>
       withRetry('engine-download', config.DOWNLOAD_RETRY_ATTEMPTS, () =>
         this.ytDlpClient.downloadFormat(request.url, formatId, workspace),
       );
 
-    if (format.hasVideo && !format.hasAudio) {
-      const audioFormat = this.pickBestAudio(formats);
+    // If the selected format is video-only (no audio track), find best audio to merge
+    if (format.hasVideo === true && format.hasAudio === false) {
+      const audioFormat = formats
+        .filter((f) => (f as any).hasAudio && !(f as any).hasVideo)
+        .sort((a, b) => ((b as any).bitrate ?? 0) - ((a as any).bitrate ?? 0))[0];
       if (audioFormat) {
         const videoPath = await download(format.id);
         const audioPath = await download(audioFormat.id);
         tracker.setStage('merging');
         const mergedPath = path.join(workspace, `merged-${request.provider}.mp4`);
         return await this.ffmpegService.mergeTracks(videoPath, audioPath, mergedPath);
       }
     }
 
     return await download(format.id);
   }
 
-  private pickBestAudio(formats: NormalizedFormat[]): NormalizedFormat | undefined {
-    return formats
-      .filter((format) => format.hasAudio && !format.hasVideo)
-      .sort((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0))[0];
-  }
-
-  private resolveMimeType(format: NormalizedFormat): string {
+  private resolveMimeType(format: { kind: string; extension?: string; hasVideo?: boolean }): string {
     if (format.kind === 'audio') {
-      return format.extension === 'mp3' ? 'audio/mpeg' : `audio/${format.extension}`;
+      return format.extension === 'mp3' ? 'audio/mpeg' : `audio/${format.extension ?? 'mp4'}`;
     }
-    return format.extension === 'mp4' || format.hasVideo ? 'video/mp4' : `video/${format.extension}`;
+    return format.extension === 'mp4' || format.hasVideo ? 'video/mp4' : `video/${format.extension ?? 'mp4'}`;
   }
 
   private buildProbe(format: NormalizedFormat, mimeType: string, duration?: number): MediaProbe {
     return {
-      mediaType: resolveMediaType({
-        kind: format.kind,
-        extension: format.extension,
-        duration,
-        mimeType,
-      }),
+      mediaType: resolveMediaType({ kind: format.kind, extension: format.extension, duration, mimeType }),
       resolution: format.resolution ?? (format.height ? `${format.height}p` : undefined),
       width: format.width,
       height: format.height,
       fps: format.fps,
       bitrate: format.bitrate,
       codec: format.kind === 'audio' ? format.audioCodec : format.videoCodec,
       size: format.filesize,
     };
   }
+
+  private toNormalized(f: any): NormalizedFormat {
+    return {
+      id: f.id,
+      kind: f.kind,
+      quality: f.quality,
+      label: f.label || f.quality,
+      container: f.extension || 'mp4',
+      extension: f.extension || 'mp4',
+      resolution: f.resolution,
+      width: f.width,
+      height: f.height,
+      fps: f.fps,
+      bitrate: f.bitrate,
+      videoCodec: f.videoCodec,
+      audioCodec: f.audioCodec,
+      filesize: f.filesize,
+      hasAudio: f.hasAudio ?? (f.kind === 'audio'),
+      hasVideo: f.hasVideo ?? (f.kind === 'video'),
+    };
+  }
 }
