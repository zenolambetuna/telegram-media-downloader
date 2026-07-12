import { BaseYtDlpProvider } from '../shared/BaseYtDlpProvider';

export class SoundCloudProvider extends BaseYtDlpProvider {
  readonly platform = 'soundcloud' as const;

  supports(url: string): boolean {
    return /soundcloud\.com/i.test(url);
  }
}
