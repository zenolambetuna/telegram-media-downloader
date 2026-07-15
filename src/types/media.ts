/**
 * ResolvedMediaInfo — the single source of truth after format resolution.
 * Every extractor (TikTok, YouTube, Instagram, Facebook, X, etc.) returns this.
 * The keyboard builder reads ONLY this structure.
 */
export interface ResolvedMediaInfo {
  platform: string;
  title: string;
  description?: string;
  duration?: number;
  thumbnail?: string;
  uploader?: string;
  originalUrl: string;
  canonicalUrl: string;
  /** True if at least one format is classified as video */
  hasVideo: boolean;
  /** True if at least one format is classified as audio */
  hasAudio: boolean;
  /** All video formats */
  videoFormats: MediaFormat[];
  /** All audio formats */
  audioFormats: MediaFormat[];
  /** The single best video format (highest quality, then highest bitrate) */
  bestVideo?: MediaFormat;
  /** The single best audio format (highest bitrate) */
  bestAudio?: MediaFormat;
  /**
   * True only when videoFormats has MORE THAN ONE distinct quality label.
   * This controls whether the resolution picker is shown.
   */
  supportsResolutionSelection: boolean;
}

export type MediaKind = 'video' | 'audio';

export type MediaType =
  | 'video'
  | 'audio'
  | 'photo'
  | 'animation'
  | 'voice'
  | 'document'
  | 'sticker';

export interface MediaFormat {
  id: string;
  kind: MediaKind;
  label: string;
  extension: string;
  quality: string;
  filesize?: number;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  audioCodec?: string;
  videoCodec?: string;
}

export interface MediaMetadata {
  id: string;
  provider: SupportedPlatform;
  originalUrl: string;
  canonicalUrl: string;
  title: string;
  description?: string;
  duration?: number;
  thumbnail?: string;
  uploader?: string;
  filesize?: number;
  formats: MediaFormat[];
}

export interface DownloadRequest {
  url: string;
  formatId: string;
  userId: number;
  chatId: number;
}

export interface MediaProbe {
  mediaType: MediaType;
  resolution?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  codec?: string;
  size?: number;
}

export interface DownloadArtifact {
  filePath: string;
  fileName: string;
  mimeType: string;
  quality: string;
  checksum: string;
  probe: MediaProbe;
  metadata: MediaMetadata;
}

export interface StoredMediaRecord {
  id?: number;
  messageId: number;
  fileId: string;
  chatId: string;
  provider: SupportedPlatform;
  originalUrl: string;
  canonicalUrl: string;
  title: string;
  description?: string;
  duration?: number;
  thumbnail?: string;
  mimeType: string;
  quality: string;
  resolution?: string;
  fps?: number;
  bitrate?: number;
  codec?: string;
  size?: number;
  uploadDate: string;
  checksum: string;
}

export interface UploadResult {
  messageId: number;
  fileId: string;
  mediaType: MediaType;
}

export interface QueueJobResult {
  messageId: number;
  cached: boolean;
}

export interface CacheLookup {
  originalUrl?: string;
  canonicalUrl?: string;
  checksum?: string;
}

/** Platform identity — runtime string, not a compile-time union */
export type SupportedPlatform = string;
