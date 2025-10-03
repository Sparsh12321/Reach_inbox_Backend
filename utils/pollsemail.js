// utils/pollEmails.js
const crypto = require("crypto");
const { htmlToText } = require("html-to-text");
const{classifierReady} = require("../config/ClassifierSetup");
async function pollNewEmails({
  activeAccount,
  setLastUid,       // callback to update lastUid in main file
  getLastUid,       // callback to get current lastUid
  fetchEmails,
  esClient,
  classifierReady,
  classifyEmail
}) {
  if (!activeAccount) return; // no logged-in account

  try {
    console.log(`🔄 Polling emails for ${activeAccount.imap_user} (lastUid: ${getLastUid() || 'initial fetch'})`);

    const { emails, lastUid: newUid } = await fetchEmails({
      imap_user: activeAccount.imap_user,
      imap_pass: activeAccount.imap_pass,
      lastUid: getLastUid(),
    });

    console.log(`📧 Fetched ${emails.length} emails from IMAP`);
    setLastUid(newUid);

    const enrichedEmails = emails.map((email) => {
      const bodyHtml = email.body || "";
      const bodyText = htmlToText(bodyHtml, { wordwrap: 130, ignoreHref: true, ignoreImage: true }).replace(/\s+/g, " ").trim();

      let label = "Unclassified";
      if (classifierReady) {
        try {
          label = classifyEmail({ ...email, body: bodyText });
        } catch (err) {
          console.warn(`⚠️ Classification failed for "${email.subject}": ${err.message}`);
        }
      }

      const emailId = crypto.createHash("md5").update((email.subject || "") + (email.date || "") + activeAccount.imap_user).digest("hex");

      return { 
        ...email, 
        _id: emailId, 
        body_html: bodyHtml, 
        body_text: bodyText, 
        label,
        account_id: activeAccount._id.toString(),
        imap_user: activeAccount.imap_user
      };
    });

    if (enrichedEmails.length > 0) {
      const bulkOps = enrichedEmails.flatMap(email => [
        { index: { _index: "emails", _id: email._id } },
        {
          from: email.from,
          subject: email.subject,
          body_html: email.body_html,
          body_text: email.body_text,
          date: email.date,
          messageId: email.messageId,
          label: email.label,
          account_id: email.account_id,
          imap_user: email.imap_user
        }
      ]);

      const bulkResponse = await esClient.bulk({ refresh: true, operations: bulkOps });
      if (bulkResponse.errors) {
        console.error("❌ Some emails failed to index:");
        bulkResponse.items.filter(item => item.index?.error).forEach(item => {
          console.error(JSON.stringify(item.index.error, null, 2));
        });
      }
      console.log(`✅ Indexed ${enrichedEmails.length} new emails for ${activeAccount.imap_user}`);
    } else {
      console.log(`📭 No new emails found for ${activeAccount.imap_user}`);
    }
  } catch (err) {
    console.error("❌ Failed to poll new emails:", err.message);
  }
}

module.exports = pollNewEmails;
