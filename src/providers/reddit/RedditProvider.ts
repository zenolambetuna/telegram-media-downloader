import { BaseYtDlpProvider } from '../shared/BaseYtDlpProvider';

export class RedditProvider extends BaseYtDlpProvider {
  readonly platform = 'reddit' as const;

  supports(url: string): boolean {
    return /reddit\.com|redd\.it/i.test(url);
  }
}
