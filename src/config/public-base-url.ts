export function parsePublicBaseUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('PUBLIC_BASE_URL must be a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('PUBLIC_BASE_URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('PUBLIC_BASE_URL must not contain credentials, query, or fragment');
  }

  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}
