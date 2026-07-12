import { BaseProvider } from '../shared/BaseProvider';

export class InstagramProvider extends BaseProvider {
  readonly platform = 'instagram' as const;
  protected readonly pattern = /instagram\.com/i;
}
