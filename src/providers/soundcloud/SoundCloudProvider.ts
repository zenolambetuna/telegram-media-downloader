import { BaseProvider } from '../shared/BaseProvider';

export class SoundCloudProvider extends BaseProvider {
  readonly platform = 'soundcloud' as const;
  protected readonly pattern = /soundcloud\.com/i;
}
