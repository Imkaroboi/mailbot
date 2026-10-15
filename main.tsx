import { createRoot } from 'react-dom/client';
import Dashboard from './app/dashboard';
import './app/globals.css';

declare global { interface Window { MAILBOT_CONFIG?: { googleClientId?: string } } }
const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || window.MAILBOT_CONFIG?.googleClientId || '';
createRoot(document.getElementById('root')!).render(<>
  <Dashboard user={null} signInPath="/" signOutPath="/" oauthClientId={clientId} />
  <footer className="public-links"><a href={`${import.meta.env.BASE_URL}privacy.html`}>Privacy &amp; your data</a><a href={`${import.meta.env.BASE_URL}about.html`}>How it works</a><a href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer">Manage Google access</a></footer>
</>);
