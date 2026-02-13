const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

export function detectUrls(text: string): string[] {
  const matches = text.match(URL_REGEX);
  if (!matches) return [];

  const cleaned = matches.map((url) => {
    return url.replace(/[.,;:!?)]+$/, '');
  });

  return [...new Set(cleaned)];
}
