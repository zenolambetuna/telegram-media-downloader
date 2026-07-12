import { BaseProvider } from '../shared/BaseProvider';

export class TwitterProvider extends BaseProvider {
  readonly platform = 'twitter' as const;
  protected readonly pattern = /(?:twitter\.com|x\.com)/i;
}
