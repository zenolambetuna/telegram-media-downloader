import { AppError } from '../types/errors';

export function assertValidUrl(input: string): URL {
  try {
    return new URL(input.trim());
  } catch (error) {
    throw new AppError('Invalid URL', 'INVALID_URL', error);
  }
}

/**
 * Resolve vt.tiktok.com short links to the real TikTok video URL.
 * TikTok short URLs redirect via HTTP 301/302 to the canonical URL.
 * This is required because yt-dlp often fails on short URLs.
 */
export async function resolveTikTokShortUrl(url: string): Promise<string> {
  const parsed = assertValidUrl(url);
  const host = parsed.hostname.toLowerCase();

  // Only resolve TikTok short links
  if (host !== 'vt.tiktok.com' && host !== 'vm.tiktok.com') {
    return url;
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.147 Mobile Safari/537.36',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        // TikTok redirects to https://www.tiktok.com/@user/video/1234567890
        return location.split('?')[0].split('#')[0];
      }
    }

    // Fallback: check if response has a refresh header or link header
    const linkHeader = response.headers.get('link');
    if (linkHeader) {
      const match = linkHeader.match(/href="([^"]+)"/);
      if (match) {
        return match[1].split('?')[0].split('#')[0];
      }
    }

    // If we can't resolve, return original URL and let yt-dlp try
    return url;
  } catch {
    // If fetch fails, return original URL
    return url;
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

  // Normalize www.tiktok.com to tiktok.com
  if (host === 'www.tiktok.com') {
    url.hostname = 'www.tiktok.com';
  }

  url.searchParams.sort();
  return url.toString();
}