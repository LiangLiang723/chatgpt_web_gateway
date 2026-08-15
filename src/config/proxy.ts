const allowedProxyProtocols = new Set(['http:', 'https:', 'socks5:']);

export function parseChatGptProxyServer(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('CHATGPT_PROXY_SERVER must be a valid proxy server URL');
  }

  if (!allowedProxyProtocols.has(url.protocol)) {
    throw new Error('CHATGPT_PROXY_SERVER must use http, https, or socks5');
  }
  if (!url.hostname || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('CHATGPT_PROXY_SERVER must contain only a proxy server origin');
  }
  if (url.username || url.password) {
    throw new Error('CHATGPT_PROXY_SERVER must not contain credentials');
  }

  return `${url.protocol}//${url.host}`;
}
