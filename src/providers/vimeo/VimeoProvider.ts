import { BaseProvider } from '../shared/BaseProvider';

export class VimeoProvider extends BaseProvider {
  readonly platform = 'vimeo' as const;
  protected readonly pattern = /vimeo\.com/i;
}
