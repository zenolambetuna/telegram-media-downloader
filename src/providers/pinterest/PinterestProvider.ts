import { BaseYtDlpProvider } from '../shared/BaseYtDlpProvider';

export class PinterestProvider extends BaseYtDlpProvider {
  readonly platform = 'pinterest' as const;

  supports(url: string): boolean {
    return /pinterest\./i.test(url);
  }
}
