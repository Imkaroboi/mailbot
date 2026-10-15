import type { GoogleSession } from '@/lib/google-mail';
import { fastReaderEnabled } from '@/lib/fast-reader';
import { fastReaderUrl } from '@/lib/runtime-config';

export function ScanNotice({ session, connecting, onConnect }: { session: GoogleSession | null; connecting: boolean; onConnect: () => void }) {
  const endpoint = fastReaderUrl();
  return <>
    {!fastReaderEnabled(session) && <div className="directory-fast-connect"><div><strong>Fast scanning is the default</strong><p>Mail scans use {endpoint ? new URL(endpoint).hostname : 'the hosted scanner'}. Your temporary Google token passes to this reader over HTTPS; it reads headers without saving tokens or mail. Google requires full mail permission, which also allows sending and permanent deletion. Mailbot’s cleanup moves reviewed emails to Trash.</p></div>{session && <button className="cleanup-btn" onClick={onConnect} disabled={connecting}>{connecting ? 'Connecting…' : 'Reconnect Google'}</button>}</div>}
    <details className="scan-limits"><summary>Scanning limits &amp; availability</summary><ul>
      <li>Google currently limits this unverified app to 100 users. Verification is needed for unrestricted access.</li>
      <li>The free scanner sleeps after 15 minutes without traffic; waking can take about a minute. Keep the tab open while connecting.</li>
      <li>Up to 8 scans can run at once across the service, with 2 per account. If it is busy, retry shortly. Speed varies with Gmail and shared capacity.</li>
      <li>Each scan has a 30-minute limit. Saved headers are kept if interrupted; retries currently reread the mailbox. There is no fixed email-count cap.</li>
      <li>Google authorization expires and may require reconnecting. Gmail quotas can still pause searches, Trash, and Undo.</li>
      <li>Free hosting has monthly usage limits and can restart or suspend the service. Mailbot reports failures and keeps completed browser progress; it never switches to a slow scan.</li>
    </ul></details>
  </>;
}
