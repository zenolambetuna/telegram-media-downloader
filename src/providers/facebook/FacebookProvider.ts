import { BaseProvider } from '../shared/BaseProvider';

export class FacebookProvider extends BaseProvider {
  readonly platform = 'facebook' as const;
  protected readonly pattern = /(?:facebook\.com|fb\.watch)/i;
}
