--- a/src/downloader/FormatResolver.ts
+++ b/src/downloader/FormatResolver.ts
@@ -1,6 +1,7 @@
-import { NormalizedFormat, QualityLabel } from '../types/download';
+import { logger } from '../logger/logger';
+import { MediaFormat, ResolvedMediaInfo } from '../types/media';
+import { NormalizedFormat, QualityLabel } from '../types/download';
 
-const HEIGHT_TO_QUALITY: Array<{ maxHeight: number; label: QualityLabel }> = [
 interface RawFormat {
   format_id?: string;
   ext?: string;
@@ -20,123 +21,166 @@ interface RawFormat {
   abr?: number;
 }
 
+const HEIGHT_TO_QUALITY: Array<{ maxHeight: number; label: QualityLabel }> = [
+  { maxHeight: 144, label: '144p' },
+  { maxHeight: 240, label: '240p' },
+  { maxHeight: 360, label: '360p' },
+  { maxHeight: 480, label: '480p' },
+  { maxHeight: 720, label: '720p' },
+  { maxHeight: 1080, label: '1080p' },
+  { maxHeight: 1440, label: '1440p' },
+  { maxHeight: 2160, label: '2160p' },
+];
+
 /**
- * FormatResolver converts the raw yt-dlp format list into a standardized,
- * normalized set of formats. Providers never see raw yt-dlp fields.
+ * FormatResolver — single pipeline stage that:
+ * 1. Takes raw yt-dlp formats
+ * 2. Normalizes each into MediaFormat with correct kind (video/audio)
+ * 3. Deduplicates by quality
+ * 4. Returns a ResolvedMediaInfo with clear hasVideo/hasAudio/supportsResolutionSelection
  */
 export class FormatResolver {
-  resolve(rawFormats: RawFormat[]): NormalizedFormat[] {
-    const normalized = rawFormats
-      .filter((format) => format.format_id && format.ext)
-      .map((format) => this.normalize(format))
-      .filter((format, index, all) => all.findIndex((item) => item.id === format.id) === index);
+  resolve(rawFormats: RawFormat[], platform: string, title: string, url: string): ResolvedMediaInfo {
+    // Step 1: Filter out entries without essential fields
+    const valid = rawFormats.filter((f) => f.format_id && f.ext);
+
+    // Step 2: Normalize each format
+    const allNormalized: MediaFormat[] = valid.map((f) => this.normalize(f));
+
+    // Step 3: Remove duplicate ids
+    const unique: MediaFormat[] = allNormalized.filter(
+      (f, i, arr) => arr.findIndex((x) => x.id === f.id) === i,
+    );
+
+    // Step 4: Separate video and audio
+    const videoFormats = unique.filter((f) => f.kind === 'video');
+    const audioFormats = unique.filter((f) => f.kind === 'audio');
+
+    // Step 5: Deduplicate video by quality (keep highest bitrate per quality)
+    const dedupedVideos = this.dedupeVideoByQuality(videoFormats);
+
+    // Step 6: Keep all audio formats (different bitrates/codecs are meaningful)
+    const dedupedAudios = audioFormats;
+
+    // Step 7: Determine supportsResolutionSelection
+    // Only true when there is MORE THAN ONE distinct quality label among video formats
+    const uniqueQualities = new Set(dedupedVideos.map((f) => f.quality));
+    const supportsResolutionSelection = uniqueQualities.size > 1;
+
+    // Step 8: Pick best video and best audio
+    const bestVideo = dedupedVideos.length > 0
+      ? this.pickBestVideo(dedupedVideos)
+      : undefined;
+    const bestAudio = dedupedAudios.length > 0
+      ? this.pickBestAudio(dedupedAudios)
+      : undefined;
+
+    // Step 9: Determine hasVideo/hasAudio
+    const hasVideo = dedupedVideos.length > 0;
+    const hasAudio = dedupedAudios.length > 0;
+
+    // Logging
+    logger.info(
+      {
+        platform,
+        hasVideo,
+        hasAudio,
+        videoFormatsCount: dedupedVideos.length,
+        audioFormatsCount: dedupedAudios.length,
+        supportsResolutionSelection,
+        qualities: [...uniqueQualities],
+      },
+      'FormatResolver resolved',
+    );
 
-    return this.dedupeByQuality(normalized);
+    return {
+      platform,
+      title,
+      originalUrl: url,
+      canonicalUrl: url,
+      hasVideo,
+      hasAudio,
+      videoFormats: dedupedVideos,
+      audioFormats: dedupedAudios,
+      bestVideo,
+      bestAudio,
+      supportsResolutionSelection,
+    };
   }
 
-  private normalize(format: RawFormat): NormalizedFormat {
-    const hasVideo = Boolean(
-      format.vcodec && format.vcodec !== 'none',
-    ) || Boolean(format.width && format.height);
-    const hasAudio = Boolean(format.acodec && format.acodec !== 'none');
-
-    // TikTok/vertical videos: dimensions may exist even if vcodec is blank/unknown.
-    // Treat any format with both width+height as video-capable.
-    // Also: if the format has NO audio but has width/height, it's always video.
-    //
-    // IMPORTANT: For merged formats (TikTok, Instagram Reels, Facebook videos)
-    // that contain BOTH video and audio tracks, we want them classified as 'video'.
-    // The old logic `resolvedHasVideo && !resolvedHasAudio ? 'video' : 'audio'`
-    // incorrectly marked merged formats as 'audio' because resolvedHasAudio was also true.
-    //
-    // New logic:
-    //   - If it has video (with or without audio) → kind='video'
-    //   - If it has ONLY audio (no video at all) → kind='audio'
-    const resolvedHasVideo = hasVideo || Boolean(format.width && format.height);
-    const resolvedHasAudio = hasAudio;
-    const resolvedKind: 'video' | 'audio' = resolvedHasVideo ? 'video' : 'audio';
+  /**
+   * Convert a single raw yt-dlp format to a MediaFormat.
+   *
+   * CRITICAL LOGIC — determines kind='video' vs kind='audio':
+   *
+   * - If the format has VIDEO (vcodec present, or width+height present) → kind='video'
+   *   regardless of whether it also has audio.
+   *   This handles merged formats (TikTok, Instagram Reels, Facebook, etc.)
+   *   that contain both video and audio tracks in one stream.
+   *
+   * - If the format has ONLY audio (no video at all) → kind='audio'
+   */
+  private normalize(format: RawFormat): MediaFormat {
+    const hasVideoSignal =
+      Boolean(format.vcodec && format.vcodec !== 'none') ||
+      Boolean(format.width && format.height);
+    const hasAudioSignal = Boolean(format.acodec && format.acodec !== 'none');
+
+    // KEY RULE: if there's any video signal, it's a video format
+    const isVideo = hasVideoSignal;
+    const isAudio = !hasVideoSignal && hasAudioSignal;
+
+    const kind: 'video' | 'audio' = isVideo ? 'video' : 'audio';
 
     // Use height for horizontal videos, width for vertical videos to get correct quality label
-    const dimension = format.width && format.height
-      ? format.width > format.height
-        ? format.height
-        : format.width
-      : format.height || format.width;
-    const quality = this.mapQuality(resolvedKind, dimension);
+    const dimension =
+      format.width && format.height
+        ? format.width > format.height
+          ? format.height
+          : format.width
+        : format.height || format.width;
+
+    const quality = this.mapQuality(kind, dimension);
     const bitrateKbps = format.vbr ?? format.abr ?? format.tbr;
 
+    const label =
+      kind === 'audio'
+        ? `Audio ${format.abr ? `${Math.round(format.abr)}kbps` : format.ext ?? ''}`.trim()
+        : quality;
+
     return {
-      id: format.format_id ?? 'unknown',
-      kind: resolvedKind,
-      quality,
-      label: resolvedKind === 'audio' ? `Audio ${format.abr ? `${Math.round(format.abr)}kbps` : format.ext ?? ''}`.trim() : quality,
-      container: format.container ?? format.ext ?? 'bin',
-      extension: format.ext ?? 'bin',
-      resolution: format.width && format.height ? `${format.width}x${format.height}` : format.resolution,
-      width: format.width,
-      height: format.height,
-      fps: format.fps,
-      bitrate: bitrateKbps ? Math.round(bitrateKbps * 1000) : undefined,
-      videoCodec: resolvedHasVideo ? format.vcodec : undefined,
-      audioCodec: resolvedHasAudio ? format.acodec : undefined,
-      filesize: format.filesize ?? format.filesize_approx,
-      hasAudio: resolvedHasAudio,
-      hasVideo: resolvedHasVideo,
+      id: format.format_id ?? 'unknown',
+      kind,
+      quality,
+      label,
+      extension: format.ext ?? 'bin',
+      width: format.width,
+      height: format.height,
+      fps: format.fps,
+      bitrate: bitrateKbps ? Math.round(bitrateKbps * 1000) : undefined,
+      videoCodec: isVideo ? format.vcodec : undefined,
+      audioCodec: isAudio ? format.acodec : undefined,
+      filesize: format.filesize ?? format.filesize_approx,
     };
   }
 
-  private mapQuality(kind: 'video' | 'audio', height?: number): QualityLabel {
-    if (kind === 'audio') {
-      return 'audio';
-    }
-    if (!height) {
-      return 'best';
-    }
-    for (const entry of HEIGHT_TO_QUALITY) {
-      if (height <= entry.maxHeight) {
-        return entry.label;
-      }
-    }
-    return '2160p';
-  }
-
-  private dedupeByQuality(formats: NormalizedFormat[]): NormalizedFormat[] {
-    const bestByKey = new Map<string, NormalizedFormat>();
-    // Separate video and audio to avoid cross-kind dedup collisions
-    const videoFormats = formats.filter((format) => format.kind === 'video');
-    const audioFormats = formats.filter((format) => format.kind === 'audio');
-
-    // For video: dedup by quality, keep highest bitrate per quality label
-    for (const format of videoFormats) {
-      const key = `video:${format.quality}`;
-      const existing = bestByKey.get(key);
-      if (!existing || (format.bitrate ?? 0) > (existing.bitrate ?? 0)) {
-        bestByKey.set(key, format);
-      }
-    }
+  private mapQuality(kind: 'video' | 'audio', height?: number): QualityLabel {
+    if (kind === 'audio') return 'audio';
+    if (!height) return 'best';
+    for (const entry of HEIGHT_TO_QUALITY) {
+      if (height <= entry.maxHeight) return entry.label;
+    }
+    return '2160p';
+  }
 
-    // For audio: keep ALL distinct audio formats (they have different bitrates/codecs)
-    for (const format of audioFormats) {
-      bestByKey.set(`audio:${format.id}`, format);
+  private dedupeVideoByQuality(formats: MediaFormat[]): MediaFormat[] {
+    const bestByQuality = new Map<string, MediaFormat>();
+    for (const f of formats) {
+      const existing = bestByQuality.get(f.quality);
+      if (!existing || (f.bitrate ?? 0) > (existing.bitrate ?? 0)) {
+        bestByQuality.set(f.quality, f);
+      }
     }
+    // Sort by quality descending
+    return [...bestByQuality.values()].sort((a, b) => {
+      const aIdx = VIDEO_LADDER.indexOf(a.quality);
+      const bIdx = VIDEO_LADDER.indexOf(b.quality);
+      if (aIdx !== bIdx) return bIdx - aIdx;
+      return (b.bitrate ?? 0) - (a.bitrate ?? 0);
+    });
+  }
+
+  private pickBestVideo(formats: MediaFormat[]): MediaFormat {
+    return formats.reduce((best, current) => {
+      const bestRank = VIDEO_LADDER.indexOf(best.quality);
+      const currentRank = VIDEO_LADDER.indexOf(current.quality);
+      if (currentRank > bestRank) return current;
+      if (currentRank === bestRank && (current.bitrate ?? 0) > (best.bitrate ?? 0))
+        return current;
+      return best;
+    });
+  }
+
+  private pickBestAudio(formats: MediaFormat[]): MediaFormat {
+    return formats.reduce((best, current) =>
+      (current.bitrate ?? 0) > (best.bitrate ?? 0) ? current : best,
+    );
+  }
+
+  /** Legacy method — returns NormalizedFormat[] for backward compat */
+  resolveLegacy(rawFormats: RawFormat[]): NormalizedFormat[] {
+    const normalized = rawFormats
+      .filter((format) => format.format_id && format.ext)
+      .map((f) => this.normalizeLegacy(f))
+      .filter((f, i, all) => all.findIndex((x) => x.id === f.id) === i);
+    return this.dedupeLegacy(normalized);
+  }
+
+  private normalizeLegacy(format: RawFormat): NormalizedFormat {
+    const hasVideo = Boolean(format.vcodec && format.vcodec !== 'none') || Boolean(format.width && format.height);
+    const hasAudio = Boolean(format.acodec && format.acodec !== 'none');
+    const resolvedHasVideo = hasVideo || Boolean(format.width && format.height);
+    const resolvedKind: 'video' | 'audio' = resolvedHasVideo ? 'video' : 'audio';
+    const dimension = format.width && format.height
+      ? format.width > format.height ? format.height : format.width
+      : format.height || format.width;
+    const quality = this.mapQuality(resolvedKind as any, dimension);
+    const bitrateKbps = format.vbr ?? format.abr ?? format.tbr;
+    return {
+      id: format.format_id ?? 'unknown',
+      kind: resolvedKind,
+      quality,
+      label: resolvedKind === 'audio' ? `Audio ${format.abr ? `${Math.round(format.abr)}kbps` : format.ext ?? ''}`.trim() : quality,
+      container: format.container ?? format.ext ?? 'bin',
+      extension: format.ext ?? 'bin',
+      resolution: format.width && format.height ? `${format.width}x${format.height}` : format.resolution,
+      width: format.width, height: format.height,
+      fps: format.fps,
+      bitrate: bitrateKbps ? Math.round(bitrateKbps * 1000) : undefined,
+      videoCodec: resolvedHasVideo ? format.vcodec : undefined,
+      audioCodec: hasAudio ? format.acodec : undefined,
+      filesize: format.filesize ?? format.filesize_approx,
+      hasAudio, hasVideo: resolvedHasVideo,
+    };
+  }
 
-    const deduped = [...bestByKey.values()].sort((left, right) => {
-      // Video first, then audio
-      if (left.kind !== right.kind) return left.kind === 'video' ? -1 : 1;
-      // Within same kind, sort by height descending
-      return (right.height ?? 0) - (left.height ?? 0);
-    });
-
-    logger.debug({ before: formats.length, after: deduped.length }, 'format dedup');
-    return deduped;
+  private dedupeLegacy(formats: NormalizedFormat[]): NormalizedFormat[] {
+    const bestByKey = new Map<string, NormalizedFormat>();
+    const videoF = formats.filter((f) => f.kind === 'video');
+    const audioF = formats.filter((f) => f.kind === 'audio');
+    for (const f of videoF) {
+      const key = `video:${f.quality}`;
+      const existing = bestByKey.get(key);
+      if (!existing || (f.bitrate ?? 0) > (existing.bitrate ?? 0)) bestByKey.set(key, f);
+    }
+    for (const f of audioF) bestByKey.set(`audio:${f.id}`, f);
+    return [...bestByKey.values()].sort((a, b) => {
+      if (a.kind !== b.kind) return a.kind === 'video' ? -1 : 1;
+      return (b.height ?? 0) - (a.height ?? 0);
+    });
   }
 }
