const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const sanitizeHtml = require("sanitize-html");

const DAY_MS = 24 * 60 * 60 * 1000;

function formatEmail(parsed) {
  let htmlBody = parsed.html || parsed.textAsHtml || "";

  htmlBody = sanitizeHtml(htmlBody, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
    allowedAttributes: {
      a: ['href', 'name', 'target'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      '*': ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
  });

  return {
    from: parsed.from?.text || "",
    subject: parsed.subject || "",
    date: parsed.date || new Date(),
    body: htmlBody,
  };
}

/**
 * Fetch new emails for a single account, using lastUid to only get new emails
 */
async function fetchEmails({ imap_user, imap_pass, lastUid = null }) {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: imap_user, pass: imap_pass },
    logger: false,
  });

  await client.connect();
  console.log(`✅ Connected to IMAP: ${imap_user}`);

  const emails = [];

  const lock = await client.getMailboxLock("INBOX");
  try {
    let uids = [];
    
    if (lastUid) {
      // Incremental fetch: get only new emails after lastUid
      console.log(`🔍 Searching for emails with UID > ${lastUid}`);
      uids = await client.search({ uid: `${lastUid + 1}:*` });
    } else {
      // Initial fetch: try to get emails from last 30 days
      console.log(`🔍 Searching for emails from last 30 days`);
      const thirtyDaysAgo = new Date(Date.now() - 0.1 * DAY_MS);
      uids = await client.search({ since: thirtyDaysAgo });
      
      // If no emails in last 30 days, fetch the most recent 50 emails
      if (uids.length === 0) {
        console.log(`📭 No emails found in last 30 days, fetching most recent 50 emails...`);
        const mailbox = await client.mailboxOpen("INBOX");
        const totalMessages = mailbox.exists;
        
        if (totalMessages > 0) {
          const startSeq = Math.max(1, totalMessages - 49); // Get last 50 emails
          uids = await client.search({ seq: `${startSeq}:*` });
        }
      }
    }
    
    console.log(`📬 Found ${uids.length} email UIDs in INBOX`);

    if (uids.length > 0) {
      console.log(`📥 Fetching ${uids.length} emails...`);
      for await (let msg of client.fetch(uids, { source: true })) {
        const parsed = await simpleParser(msg.source);
        const email = formatEmail(parsed);
        email.uid = msg.uid;
        email.messageId = parsed.messageId || `${msg.uid}@${imap_user}`;
        emails.push(email);
      }
      console.log(`✅ Successfully fetched and parsed ${emails.length} emails`);
    } else {
      console.log(`📭 Inbox appears to be empty`);
    }
  } finally {
    lock.release();
    await client.logout();
  }

  const newLastUid = emails.length ? Math.max(...emails.map(e => e.uid)) : lastUid;
  return { emails, lastUid: newLastUid };
}

module.exports = fetchEmails;
