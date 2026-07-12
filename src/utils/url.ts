import { AppError } from '../types/errors';

export function assertValidUrl(input: string): URL {
  try {
    return new URL(input.trim());
  } catch (error) {
    throw new AppError('Invalid URL', 'INVALID_URL', error);
  }
}

export function normalizeUrl(value: string): string {
  const url = assertValidUrl(value);
  url.hash = '';
  const host = url.hostname.toLowerCase();

  if ((host === 'youtube.com' || host === 'www.youtube.com') && url.searchParams.has('v')) {
    return `https://www.youtube.com/watch?v=${url.searchParams.get('v')}`;
  }

  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return `https://www.youtube.com/watch?v=${id}`;
  }

  url.searchParams.sort();
  return url.toString();
}
