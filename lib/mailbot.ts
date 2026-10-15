export const GMAIL_CONNECTOR = "connector_2128aebfecb84f64a069897515042a44";
export const DRIVE_CONNECTOR = "connector_5f3c8c41a1e54ad7a76272c89e2554fa";

export const mailSearches = [
  { category: "Promotions", query: "category:promotions older_than:6m -in:trash -is:starred -label:IMPORTANT" },
  { category: "Newsletters", query: "(unsubscribe OR \"manage preferences\") older_than:6m -in:trash -is:starred -label:IMPORTANT" },
  { category: "Old mail", query: "older_than:2y -in:trash -in:spam -is:starred -label:IMPORTANT" },
  { category: "Large mail", query: "larger:5M -in:trash -is:starred -label:IMPORTANT" },
  { category: "Spam", query: "in:spam older_than:30d -is:starred" },
] as const;

export type CleanupItem = {
  id: string;
  source: "gmail" | "drive";
  title: string;
  subtitle: string;
  category: string;
  reason: string;
  confidence: "High" | "Medium" | "Review";
  size: number | null;
  date: string | null;
  url: string;
  canTrash: boolean;
  protected?: boolean;
};

type Mail = { id?: string; subject?: string; from_?: string; snippet?: string; email_ts?: string; display_url?: string; labels?: string[]; has_attachment?: boolean };
type DriveFile = { id?: string; title?: string; display_title?: string; url?: string; display_url?: string; size?: string | number; updated_at?: string; mime_type?: string; shared?: boolean; file_or_folder?: string };

export function mailItem(mail: Mail, category: string): CleanupItem | null {
  if (!mail.id) return null;
  const protectedMail = (mail.labels || []).some((label) => ["STARRED", "IMPORTANT", "SENT", "DRAFT"].includes(label));
  const reason = category === "Large mail" ? "Large message with potential storage impact" :
    category === "Spam" ? "Old spam that is usually safe to remove" :
    category === "Newsletters" ? "Older newsletter or subscription email" :
    category === "Promotions" ? "Older promotional email" : "Mail older than two years";
  return {
    id: mail.id, source: "gmail", title: mail.subject || "(No subject)",
    subtitle: mail.from_ || mail.snippet || "Gmail message", category, reason,
    confidence: protectedMail ? "Review" : category === "Spam" ? "High" : "Medium",
    size: category === "Large mail" ? 5_000_000 : null, date: mail.email_ts || null,
    url: mail.display_url || `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(mail.id)}`,
    canTrash: !protectedMail, protected: protectedMail,
  };
}

export function driveItems(files: DriveFile[]): CleanupItem[] {
  const byName = new Map<string, DriveFile[]>();
  for (const file of files) {
    if (!file.id || file.file_or_folder === "folder") continue;
    const name = (file.title || file.display_title || "").trim().toLowerCase();
    if (name) byName.set(name, [...(byName.get(name) || []), file]);
  }
  return files.flatMap((file) => {
    if (!file.id || file.file_or_folder === "folder") return [];
    const size = Number(file.size);
    const name = file.title || file.display_title || "Untitled file";
    const modified = file.updated_at ? new Date(file.updated_at).getTime() : Date.now();
    const old = Date.now() - modified > 365 * 24 * 60 * 60 * 1000;
    const duplicateName = (byName.get(name.trim().toLowerCase()) || []).length > 1;
    const large = Number.isFinite(size) && size > 10_000_000;
    if (!old && !duplicateName && !large) return [];
    const category = duplicateName ? "Same-name files" : large ? "Large files" : "Old files";
    const reason = duplicateName ? "Shares a name with another file; inspect before removing either copy" :
      large ? "Large file that may be using storage" : "Not modified in over a year";
    return [{ id: file.id, source: "drive" as const, title: name,
      subtitle: file.mime_type?.includes("google-apps") ? "Google Workspace file" : "Drive file",
      category, reason, confidence: "Review" as const,
      size: Number.isFinite(size) ? size : null,
      date: file.updated_at || null, url: file.display_url || file.url || `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`,
      canTrash: false }];
  });
}
