import { BaseProvider } from '../shared/BaseProvider';

export class ThreadsProvider extends BaseProvider {
  readonly platform = 'threads' as const;
  protected readonly pattern = /threads\.net/i;
}
