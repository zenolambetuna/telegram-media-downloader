--- a/src/downloader/MetadataService.ts
+++ b/src/downloader/MetadataService.ts
@@ -1,5 +1,5 @@
-import { EngineMetadata } from '../types/download';
-import { MediaMetadata, SupportedPlatform } from '../types/media';
+import { ResolvedMediaInfo } from '../types/media';
 import { normalizeUrl } from '../utils/url';
 import { withTimeout } from '../utils/time';
 import { config } from '../config/env';
@@ -13,8 +13,8 @@ interface RawMetadata {
   is_live?: boolean;
   live_status?: string;
   _type?: string;
   formats?: unknown[];
-  extractor?: string;
+  extractor_key?: string;
 }
 
 /**
@@ -27,57 +27,24 @@ export class MetadataService {
     private readonly formatResolver: FormatResolver,
   ) {}
 
-  async fetch(url: string, provider: SupportedPlatform): Promise<EngineMetadata> {
+  async fetch(url: string, provider: string): Promise<ResolvedMediaInfo> {
     const raw = (await withTimeout(
       this.ytDlpClient.extract(url),
       config.PROVIDER_TIMEOUT_MS,
       'metadata timeout',
     )) as RawMetadata;
 
-    // DEBUG: Log raw yt-dlp formats before FormatResolver
-    const rawFormatsBeforeResolver = (raw.formats ?? []) as Array<{
-      format_id?: string;
-      ext?: string;
-      vcodec?: string;
-      acodec?: string;
-      width?: number;
-      height?: number;
-      protocol?: string;
-      filesize?: number;
-      filesize_approx?: number;
-      format_note?: string;
-      tbr?: number;
-      vbr?: number;
-      abr?: number;
-    }>;
-    console.log('[DEBUG] RAW formats BEFORE FormatResolver (COMPLETE):', JSON.stringify(rawFormatsBeforeResolver, null, 2));
-
-    const formatResolverOutput = this.formatResolver.resolve((raw.formats ?? []) as never[]);
-    const formats = formatResolverOutput;
-
-    // DEBUG: Log FormatResolver output
-    console.log('[DEBUG] FormatResolver.resolve() output:', {
-      total: formats.length,
-      video: formats.filter(f => f.kind === 'video').length,
-      audio: formats.filter(f => f.kind === 'audio').length,
-      samples: formats.map(f => ({ id: f.id, kind: f.kind, quality: f.quality, hasVideo: f.hasVideo, hasAudio: f.hasAudio }))
-    });
-
     const isLive = Boolean(raw.is_live) || raw.live_status === 'is_live';
-    const isPlaylist = raw._type === 'playlist';
-
-    const mappedFormats = formats.map((format) => ({
-      id: format.id,
-      kind: format.kind,
-      label: format.label,
-      extension: format.extension,
-      quality: format.quality,
-      filesize: format.filesize,
-      width: format.width,
-      height: format.height,
-      fps: format.fps,
-      bitrate: format.bitrate,
-      audioCodec: format.audioCodec,
-      videoCodec: format.videoCodec,
-    }));
+    if (isLive) {
+      throw Object.assign(new Error('Live streams are not downloadable yet'), { code: 'LIVE_STREAM' });
+    }
 
-    // DEBUG: Log mapped MediaFormat[]
-    console.log('[DEBUG] Mapped MediaFormat[]:', {
-      total: mappedFormats.length,
-      video: mappedFormats.filter(f => f.kind === 'video').length,
-      audio: mappedFormats.filter(f => f.kind === 'audio').length,
-      types: mappedFormats.map(f => ({ id: f.id, kind: f.kind, quality: f.quality }))
-    });
+    const platform = provider || raw.extractor_key?.toLowerCase() || 'unknown';
+    const title = raw.title || 'Untitled';
+    const canonicalUrl = normalizeUrl(raw.webpage_url ?? url);
 
-    const metadata: MediaMetadata = {
-      id: raw.id ?? 'unknown',
-      provider,
-      originalUrl: url,
-      canonicalUrl: normalizeUrl(raw.webpage_url ?? url),
-      title: raw.title ?? 'Untitled',
-      description: raw.description,
-      duration: raw.duration,
-      thumbnail: raw.thumbnail,
-      uploader: raw.uploader,
-      filesize: raw.filesize,
-      formats: mappedFormats,
-    };
+    const resolved = this.formatResolver.resolve(
+      (raw.formats ?? []) as never[],
+      platform,
+      title,
+      url,
+    );
+
+    // Fill in additional metadata fields from raw yt-dlp data
+    resolved.canonicalUrl = canonicalUrl;
+    resolved.description = raw.description;
+    resolved.duration = raw.duration;
+    resolved.thumbnail = raw.thumbnail;
+    resolved.uploader = raw.uploader;
 
-    return { metadata, formats, isLive, isPlaylist };
+    logger.info(
+      {
+        platform: resolved.platform,
+        hasVideo: resolved.hasVideo,
+        hasAudio: resolved.hasAudio,
+        videoCount: resolved.videoFormats.length,
+        audioCount: resolved.audioFormats.length,
+        supportsResolutionSelection: resolved.supportsResolutionSelection,
+        title: resolved.title,
+      },
+      'MetadataService resolved',
+    );
+
+    return resolved;
   }
 }
