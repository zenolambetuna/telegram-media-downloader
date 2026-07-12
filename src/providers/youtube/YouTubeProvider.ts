import { BaseYtDlpProvider } from '../shared/BaseYtDlpProvider';

export class YouTubeProvider extends BaseYtDlpProvider {
  readonly platform = 'youtube' as const;

  supports(url: string): boolean {
    return /(?:youtube\.com|youtu\.be)/i.test(url);
  }
}
