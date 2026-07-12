import { BaseYtDlpProvider } from '../shared/BaseYtDlpProvider';

export class TikTokProvider extends BaseYtDlpProvider {
  readonly platform = 'tiktok' as const;

  supports(url: string): boolean {
    return /tiktok\.com/i.test(url);
  }
}
