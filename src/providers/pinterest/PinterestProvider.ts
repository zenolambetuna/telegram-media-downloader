import { BaseProvider } from '../shared/BaseProvider';

export class PinterestProvider extends BaseProvider {
  readonly platform = 'pinterest' as const;
  protected readonly pattern = /pinterest\./i;
}
