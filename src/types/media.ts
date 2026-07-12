export type SupportedPlatform =
  | 'youtube'
  | 'facebook'
  | 'instagram'
  | 'twitter'
  | 'tiktok'
  | 'threads'
  | 'reddit'
  | 'pinterest'
  | 'vimeo'
  | 'soundcloud';

export type MediaKind = 'video' | 'audio';

export interface MediaFormat {
  id: string;
  kind: MediaKind;
  label: string;
  extension: string;
  quality: string;
  filesize?: number;
  audioCodec?: string;
  videoCodec?: string;
}

export interface MediaMetadata {
  id: string;
  provider: SupportedPlatform;
  originalUrl: string;
  canonicalUrl: string;
  title: string;
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

export interface DownloadArtifact {
  filePath: string;
  fileName: string;
  mimeType: string;
  quality: string;
  checksum: string;
  metadata: MediaMetadata;
}

export interface StoredMediaRecord {
  id?: number;
  messageId: number;
  fileId: string;
  provider: SupportedPlatform;
  originalUrl: string;
  canonicalUrl: string;
  title: string;
  duration?: number;
  thumbnail?: string;
  quality: string;
  mimeType: string;
  uploadDate: string;
  checksum: string;
}

export interface QueueJobResult {
  messageId: number;
  cached: boolean;
}
