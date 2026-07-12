import { BaseYtDlpProvider } from '../shared/BaseYtDlpProvider';

export class FacebookProvider extends BaseYtDlpProvider {
  readonly platform = 'facebook' as const;

  supports(url: string): boolean {
    return /(?:facebook\.com|fb\.watch)/i.test(url);
  }
}
