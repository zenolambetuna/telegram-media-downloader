import { BaseYtDlpProvider } from '../shared/BaseYtDlpProvider';

export class TwitterProvider extends BaseYtDlpProvider {
  readonly platform = 'twitter' as const;

  supports(url: string): boolean {
    return /(?:twitter\.com|x\.com)/i.test(url);
  }
}
