declare global { interface Window { MAILBOT_CONFIG?: { googleClientId?: string; scannerUrl?: string } } }

export function fastReaderUrl(): string {
  const configured = import.meta.env?.VITE_FAST_READER_URL || (typeof window !== 'undefined' ? window.MAILBOT_CONFIG?.scannerUrl : '') || '';
  if (!configured) return '';
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return '';
    return url.origin;
  } catch { return ''; }
}
