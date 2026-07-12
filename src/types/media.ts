export type SupportedPlatform =
  | 'youtube'
  | 'facebook'
  | 'instagram'
  | 'twitter'
  | 'tiktok'
  | 'threads'
  | 'vimeo'
  | 'reddit'
  | 'pinterest'
  | 'soundcloud';

export type MediaKind = 'video' | 'audio';

export interface MediaMetadata {
  id: string;
  originalUrl: string;
  canonicalUrl: string;
  platform: SupportedPlatform;
  title: string;
  duration?: number;
  uploader?: string;
  thumbnail?: string;
  filesize?: number;
  webpageUrl?: string;
  formats: MediaFormat[];
}

export interface MediaFormat {
  id: string;
  label: string;
  extension: string;
  kind: MediaKind;
  quality?: string;
  filesize?: number;
  formatNote?: string;
  audioCodec?: string;
  videoCodec?: string;
}

export interface DownloadRequest {
  url: string;
  formatId: string;
  kind: MediaKind;
  userId: number;
}

export interface DownloadResult {
  filePath: string;
  fileName: string;
  mimeType: string;
  quality: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  platform: SupportedPlatform;
  originalUrl: string;
}

export interface CachedMediaRecord {
  messageId: number;
  fileId: string;
  platform: SupportedPlatform;
  originalUrl: string;
  canonicalUrl: string;
  title: string;
  duration?: number;
  thumbnail?: string;
  quality: string;
  mimeType: string;
  uploadDate: string;
}
