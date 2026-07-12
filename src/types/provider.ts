import { DownloadRequest, DownloadResult, MediaMetadata, SupportedPlatform } from './media';

export interface MediaProvider {
  readonly platform: SupportedPlatform;
  supports(url: string): boolean;
  getMetadata(url: string): Promise<MediaMetadata>;
  download(request: DownloadRequest): Promise<DownloadResult>;
}
