import { BaseYtDlpProvider } from '../shared/BaseYtDlpProvider';

export class ThreadsProvider extends BaseYtDlpProvider {
  readonly platform = 'threads' as const;

  supports(url: string): boolean {
    return /threads\.net/i.test(url);
  }
}
