/**
 * Platform identity is now a runtime string, not a compile-time union.
 * This is the single change that unlocks true zero-core-edit providers:
 * adding a new provider never requires editing this type. The alias is kept
 * for backward compatibility so every existing import keeps working.
 */
export type SupportedPlatform = string;

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
