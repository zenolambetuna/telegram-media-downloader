import { BaseYtDlpProvider } from '../shared/BaseYtDlpProvider';

export class VimeoProvider extends BaseYtDlpProvider {
  readonly platform = 'vimeo' as const;

  supports(url: string): boolean {
    return /vimeo\.com/i.test(url);
  }
}
