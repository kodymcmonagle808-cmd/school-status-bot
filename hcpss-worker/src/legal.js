// Single source for the Terms and Privacy Policy text, used by the /terms
// and /privacy slash commands and served as web pages at GET /terms and
// GET /privacy (public URLs for bot listings). Condensed from the full
// markdown documents at the repo root — keep all three in sync.

export const TERMS_MD =
  '**Last Updated: July 18, 2026**\n\n' +
  'By adding School Status to a server or using its commands, you agree to these Terms.\n\n' +
  '**1. Service** — The bot monitors publicly available HCPSS information (delays, closures, alerts) and posts automated status updates. It is an **independent, unofficial project** — not created, operated, endorsed, or affiliated with HCPSS or Howard County Government.\n\n' +
  '**2. Acceptance** — Inviting the bot, using its commands, or remaining in a server where it is active constitutes acceptance of these Terms and the Privacy Policy (see `/privacy`). If you do not agree, remove the bot and stop using it.\n\n' +
  '**3. No Guarantee of Accuracy** — Status updates are for **convenience only** and are never an official or authoritative source. Always confirm closures, delays, or emergency information through official HCPSS channels (hcpss.org, official social media, or direct school communication). We are not responsible for delayed, missed, incorrect, or outdated updates.\n\n' +
  "**4. Acceptable Use** — Do not use the bot to violate Discord's Terms of Service or Community Guidelines; exploit, reverse-engineer, spam, or abuse it; spread misinformation; or interfere with its operation.\n\n" +
  '**5. Server Owner Responsibilities** — Configure the bot appropriately for your community, inform members it is unofficial, and remove it if you no longer wish to use it (removal deletes server configuration data as described in the Privacy Policy).\n\n' +
  '**6. Availability** — Provided "as-is" and "as-available" with no uptime guarantee. Features may change or be removed, and the bot may be suspended or discontinued, at any time without notice.\n\n' +
  '**7. Limitation of Liability** — To the fullest extent permitted by law, the developers are not liable for damages arising from reliance on the bot, missed or inaccurate status information, downtime, bugs, or data loss. **Use for time-sensitive or safety-related decisions is at your own risk — always verify with official HCPSS sources.**\n\n' +
  '**8. Termination** — Any server or user may be blocked from the bot at any time, for any reason, including violation of these Terms.\n\n' +
  '**9. Changes** — These Terms may be updated periodically; continued use after changes constitutes acceptance of the revised Terms.\n\n' +
  "**10. Contact** — Questions can be directed to the bot developer through the support server or the contact method on the bot's official listing page.";

export const PRIVACY_MD =
  '**Last Updated: July 18, 2026**\n\n' +
  '**1. What We Collect** — The minimum needed to function: server (guild) ID, configured channel IDs, optional ping role IDs, server-specific settings, the user/channel ID at the time a command is run (used only to process that command), and — only if a user opts in via `/myschool` — the school name they registered (used solely to match public notices for DM alerts; cleared with `/myschool clear`).\n\n' +
  '**We do NOT collect** message content outside of command interactions, private messages, personal information (names, emails, school enrollment data), or voice/audio data.\n\n' +
  '**2. How It Is Used** — Solely to deliver status updates to configured channels, ping configured roles, respond to commands, and maintain/troubleshoot the bot. Data is never sold, rented, or shared with third parties for advertising or marketing.\n\n' +
  "**3. Storage & Security** — Configuration data is stored in a secure database on the bot's hosting infrastructure with reasonable technical protections. No system is 100% secure; data is stored and processed at your own risk.\n\n" +
  "**4. Retention & Deletion** — Server data is kept only while the bot remains in your server; removing the bot deletes it automatically or within a reasonable period. Admins may also erase it at any time with the `/mydata delete` command, or request manual deletion through the bot's support channel.\n\n" +
  "**5. Third-Party Services** — The bot reads publicly available HCPSS information one-way; none of your Discord data is shared with HCPSS or any third party. Discord's own Privacy Policy and Terms of Service apply to data Discord itself collects.\n\n" +
  "**6. Children's Privacy** — The bot does not knowingly collect personal information from anyone and does not target children. Discord's own minimum age requirements apply.\n\n" +
  "**7. Your Rights** — Server admins may view everything stored for their server with `/mydata view`, delete it with `/mydata delete` (removing the bot also accomplishes this), and reach out with questions about data handling.\n\n" +
  '**8. Changes** — This policy may be updated periodically; continued use after updates constitutes acceptance.\n\n' +
  "**9. Contact** — For questions or data deletion requests, reach out through the bot's support server or the contact method on its official listing page.";

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Minimal renderer for the subset of markdown the legal text uses:
// **bold**, `code`, and blank-line paragraph breaks.
function mdToHtml(md) {
  return escapeHtml(md)
    .split('\n\n')
    .map(par => {
      const inner = par
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
      return `<p>${inner}</p>`;
    })
    .join('\n');
}

export function legalPageResponse(title, md) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — School Status Bot</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.6;
         max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.6rem; }
  code { background: rgba(127,127,127,.15); padding: .1em .35em; border-radius: 4px; }
  footer { margin-top: 3rem; font-size: .85rem; opacity: .7; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${mdToHtml(md)}
<footer>School Status is an independent, unofficial Discord bot. It is not affiliated with the Howard County Public School System. · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></footer>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
