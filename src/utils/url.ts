export function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  url.hash = '';
  if ((url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com') && url.searchParams.has('v')) {
    const videoId = url.searchParams.get('v');
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  return url.toString();
}
