import { BaseProvider } from '../shared/BaseProvider';

export class TikTokProvider extends BaseProvider {
  readonly platform = 'tiktok' as const;
  protected readonly pattern = /tiktok\.com/i;
}
