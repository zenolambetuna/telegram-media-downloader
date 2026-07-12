import { BaseProvider } from '../shared/BaseProvider';

export class YouTubeProvider extends BaseProvider {
  readonly platform = 'youtube' as const;
  protected readonly pattern = /(?:youtube\.com|youtu\.be)/i;
}
