export class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function tokenVerifier(clientIds, fetchGoogle = fetch) {
  if (!clientIds.size) throw new Error('GOOGLE_CLIENT_IDS must contain the app’s public OAuth client ID.');
  return async (token, signal) => {
    // POST keeps access tokens out of URL query strings and access logs.
    const infoResponse = await fetchGoogle('https://oauth2.googleapis.com/tokeninfo', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: token }),
    });
    if (!infoResponse.ok) throw new RequestError(401, 'Reconnect Google to renew your fast-scanner permission.');
    const info = await infoResponse.json();
    if (!clientIds.has(info.aud) || !Number.isFinite(Number(info.expires_in)) || Number(info.expires_in) <= 0) throw new RequestError(401, 'This Google authorization is not valid for Mailbot.');
    if (!String(info.scope || '').split(' ').includes('https://mail.google.com/')) throw new RequestError(403, 'Connect fast scanning and approve Google’s full mail permission.');
    const response = await fetchGoogle('https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress', { signal, headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new RequestError(response.status === 429 ? 429 : 401, 'Google could not verify this account. Reconnect or try again shortly.');
    const profile = await response.json();
    if (typeof profile.emailAddress !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(profile.emailAddress)) throw new RequestError(401, 'Google did not confirm the account.');
    return profile.emailAddress.toLowerCase();
  };
}
