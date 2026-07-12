import { MediaMetadata, MediaProbe, SupportedPlatform } from './media';

export type DownloadStage =
  | 'fetching_metadata'
  | 'resolving_formats'
  | 'downloading'
  | 'merging'
  | 'processing'
  | 'uploading'
  | 'finished';

export interface ProgressUpdate {
  stage: DownloadStage;
  ratio?: number;
  detail?: string;
}

export type ProgressListener = (update: ProgressUpdate) => void;

export type QualityLabel =
  | '144p'
  | '240p'
  | '360p'
  | '480p'
  | '720p'
  | '1080p'
  | '1440p'
  | '2160p'
  | 'best'
  | 'audio';

export interface NormalizedFormat {
  id: string;
  kind: 'video' | 'audio';
  quality: QualityLabel;
  label: string;
  container: string;
  extension: string;
  resolution?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  videoCodec?: string;
  audioCodec?: string;
  filesize?: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export interface EngineMetadata {
  metadata: MediaMetadata;
  formats: NormalizedFormat[];
  isLive: boolean;
  isPlaylist: boolean;
}

export interface EngineDownloadRequest {
  url: string;
  provider: SupportedPlatform;
  formatId: string;
  userId: number;
  chatId: number;
  onProgress?: (update: import('./download').ProgressUpdate) => void;
}

export interface EngineDownloadResult {
  filePath: string;
  fileName: string;
  mimeType: string;
  quality: string;
  checksum: string;
  probe: MediaProbe;
  metadata: MediaMetadata;
  thumbnailPath?: string;
}
