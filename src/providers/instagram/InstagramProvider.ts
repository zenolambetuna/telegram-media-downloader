import { BaseYtDlpProvider } from '../shared/BaseYtDlpProvider';

export class InstagramProvider extends BaseYtDlpProvider {
  readonly platform = 'instagram' as const;

  supports(url: string): boolean {
    return /instagram\.com/i.test(url);
  }
}
