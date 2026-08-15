export interface SafeChatGptConversationUrl {
  href: string;
  pathname: string;
}

export function parseSafeChatGptConversationUrl(
  value: string,
): SafeChatGptConversationUrl | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.pathname === '/') {
      return undefined;
    }
    return {
      href: url.href,
      pathname: url.pathname,
    };
  } catch {
    return undefined;
  }
}
