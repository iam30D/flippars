const normalizeBaseUrl = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const localDevelopment =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(localDevelopment && url.protocol === "http:"))
      return null;
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
};

export const env = Object.freeze({
  apiUrl: normalizeBaseUrl(process.env.EXPO_PUBLIC_API_URL),
  demoMode: process.env.EXPO_PUBLIC_DEMO_MODE?.toLowerCase() === "true",
});
