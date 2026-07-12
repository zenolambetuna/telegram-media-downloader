import { BaseProvider } from '../shared/BaseProvider';

export class RedditProvider extends BaseProvider {
  readonly platform = 'reddit' as const;
  protected readonly pattern = /(?:reddit\.com|redd\.it)/i;
}
