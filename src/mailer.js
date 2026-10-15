// Email delivery (double opt-in confirmations + daily digest to confirmed subscribers only).
// Disabled unless EMAIL_SENDING_ENABLED === "true" AND a provider key is configured as a secret.
// Providers: Brevo (BREVO_API_KEY) or Resend (RESEND_API_KEY). Sender name "Upstream digest", replies to REPLY_TO.
const API = "https://upstream.toolweather.workers.dev";
const now = () => new Date().toISOString();
export const mailReady = (env) => env.EMAIL_SENDING_ENABLED === "true" && !!(env.BREVO_API_KEY || env.RESEND_API_KEY) && !!env.MAIL_FROM;

async function sendOne(env, { to, subject, text, html, unsubUrl }) {
  const headers = { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  const from = { name: "Upstream digest", email: env.MAIL_FROM }, reply = env.REPLY_TO || "toolweather@mail.grokbot.com";
  let r;
  if (env.BREVO_API_KEY) r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ sender: from, to: [{ email: to }], replyTo: { email: reply }, subject, textContent: text, htmlContent: html, headers }) });
  else r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ from: `Upstream digest <${env.MAIL_FROM}>`, to: [to], reply_to: reply, subject, text, html, headers }) });
  return { ok: r.ok, status: r.status, detail: r.ok ? null : (await r.text()).slice(0, 300) };
}
// Rate limit: at most MAIL_PER_RUN per cron run (default 20) and MAIL_PER_DAY per UTC day (default 250, under free-tier caps)
async function budget(env) {
  const d = now().slice(0, 10), perDay = +(env.MAIL_PER_DAY || 250);
  const used = (await env.DB.prepare("SELECT COUNT(*) n FROM email_outbox WHERE state='sent' AND sent_at>=?").bind(d).first()).n;
  return Math.max(0, Math.min(+(env.MAIL_PER_RUN || 20), perDay - used));
}
export async function drainOutbox(env) {
  if (!mailReady(env)) return { sent: 0, reason: "sending disabled" };
  let n = await budget(env), sent = 0, failed = 0;
  if (!n) return { sent: 0, reason: "rate limit" };
  const rows = (await env.DB.prepare("SELECT o.*, s.status sstatus FROM email_outbox o JOIN subscribers s ON s.email=o.email WHERE o.state IN ('queued','held_sending_disabled') ORDER BY o.id LIMIT ?").bind(n).all()).results;
  for (const o of rows) {
    // confirmations only to pending, digests only to confirmed: nothing else is ever sent
    if ((o.kind === "confirm" && o.sstatus !== "pending") || (o.kind === "digest" && o.sstatus !== "confirmed") || !["confirm", "digest"].includes(o.kind)) { await env.DB.prepare("UPDATE email_outbox SET state='skipped' WHERE id=?").bind(o.id).run(); continue; }
    const m = JSON.parse(o.body);
    const r = await sendOne(env, { to: o.email, subject: o.subject, ...m });
    await env.DB.prepare("UPDATE email_outbox SET state=?, sent_at=?, error=? WHERE id=?").bind(r.ok ? "sent" : (o.attempts >= 2 ? "failed" : "queued"), now(), r.detail, o.id).run();
    await env.DB.prepare("UPDATE email_outbox SET attempts=COALESCE(attempts,0)+1 WHERE id=?").bind(o.id).run();
    r.ok ? sent++ : failed++;
  }
  return { sent, failed };
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function confirmMail(ct, ut) {
  const c = `${API}/digest/confirm?token=${ct}`, u = `${API}/digest/unsubscribe?token=${ut}`;
  return { unsubUrl: u, text: `Please confirm you want the Upstream breaking-changes digest (one short email a day).\n\nConfirm: ${c}\n\nIf you didn't ask for this, ignore this email and you won't hear from us again.\nUnsubscribe: ${u}`,
    html: `<p>Please confirm you want the Upstream breaking-changes digest (one short email a day).</p><p><a href="${c}">Confirm my subscription</a></p><p style="color:#666">If you didn't ask for this, ignore this email and you won't hear from us again. <a href="${u}">Unsubscribe</a></p>` };
}
export function digestMail(d, unsubUrl) {
  const html = esc(d.markdown).replace(/^# (.*)$/gm, "<h2>$1</h2>").replace(/^## (.*)$/gm, "<h3>$1</h3>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>').replace(/^- (.*)$/gm, "• $1<br>").replace(/\n\n/g, "<br><br>");
  return { unsubUrl, text: `${d.markdown}\n\nRead online: https://upstream-api.pages.dev/digest/?d=${d.date}\nUnsubscribe: ${unsubUrl}`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:640px;line-height:1.5">${html}<hr><p style="color:#666;font-size:13px"><a href="https://upstream-api.pages.dev/digest/?d=${d.date}">Read online</a> · <a href="${unsubUrl}">Unsubscribe</a></p></div>` };
}
