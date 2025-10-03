const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const esClient = require("../config/esClient");
const crypto = require("crypto");
const { htmlToText } = require("html-to-text");
const { classifyEmail } = require("./classifier");
const sanitizeHtml = require("sanitize-html");

class ImapSyncService {
  constructor() {
    this.clients = new Map(); // Map of account_id -> ImapFlow client
    this.syncState = new Map(); // Map of account_id -> { lastUid, uidValidity }
  }

  /**
   * Start IMAP IDLE sync for an account
   */
  async startSync(account) {
    const accountId = account._id.toString();
    
    // Stop existing sync if running
    if (this.clients.has(accountId)) {
      await this.stopSync(accountId);
    }

    console.log(`🔄 Starting IMAP sync for ${account.imap_user}`);

    try {
      const client = new ImapFlow({
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        auth: { user: account.imap_user, pass: account.imap_pass },
        logger: false,
      });

      // Handle connection errors
      client.on("error", (err) => {
        console.error(`❌ IMAP error for ${account.imap_user}:`, err.message);
        // Attempt to reconnect after error
        setTimeout(() => this.startSync(account), 5000);
      });

      client.on("close", () => {
        console.log(`🔌 IMAP connection closed for ${account.imap_user}`);
        // Attempt to reconnect
        setTimeout(() => this.startSync(account), 3000);
      });

      await client.connect();
      console.log(`✅ IMAP connected: ${account.imap_user}`);

      this.clients.set(accountId, client);

      // Initial sync
      await this.performSync(account, client);

      // Start IDLE monitoring for real-time updates
      await this.startIdleMonitoring(account, client);

    } catch (error) {
      console.error(`❌ Failed to start sync for ${account.imap_user}:`, error.message);
      // Retry after 10 seconds
      setTimeout(() => this.startSync(account), 10000);
    }
  }

  /**
   * Perform initial or incremental sync
   */
  async performSync(account, client) {
    const accountId = account._id.toString();
    
    try {
      const lock = await client.getMailboxLock("INBOX");
      
      try {
        const mailboxStatus = await client.status("INBOX", { 
          messages: true, 
          uidNext: true, 
          uidValidity: true 
        });

        const syncState = this.syncState.get(accountId) || { lastUid: 0 };
        const currentUidValidity = mailboxStatus.uidValidity;

        // Check if UIDVALIDITY changed (means mailbox was reset)
        if (syncState.uidValidity && syncState.uidValidity !== currentUidValidity) {
          console.log(`⚠️ UIDVALIDITY changed for ${account.imap_user}, performing full sync`);
          syncState.lastUid = 0;
        }

        syncState.uidValidity = currentUidValidity;

        // Fetch emails newer than lastUid
        let uids = [];
        if (syncState.lastUid > 0) {
          console.log(`🔍 Syncing emails with UID > ${syncState.lastUid}`);
          uids = await client.search({ uid: `${syncState.lastUid + 1}:*` });
        } else {
          // Initial sync: get recent emails (last 30 days or last 100)
          console.log(`🔍 Initial sync for ${account.imap_user}`);
          const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          uids = await client.search({ since: thirtyDaysAgo });
          
          // Limit to last 100 emails on initial sync
          if (uids.length > 100) {
            uids = uids.slice(-100);
          }
        }

        if (uids.length > 0) {
          console.log(`📥 Syncing ${uids.length} emails for ${account.imap_user}`);
          await this.fetchAndIndexEmails(account, client, uids);
          
          // Update lastUid
          syncState.lastUid = Math.max(...uids);
          this.syncState.set(accountId, syncState);
        } else {
          console.log(`✅ No new emails to sync for ${account.imap_user}`);
        }

      } finally {
        lock.release();
      }

    } catch (error) {
      console.error(`❌ Sync error for ${account.imap_user}:`, error.message);
    }
  }

  /**
   * Start IMAP IDLE monitoring for real-time updates
   */
  async startIdleMonitoring(account, client) {
    const accountId = account._id.toString();

    try {
      const lock = await client.getMailboxLock("INBOX");

      try {
        // Start IDLE mode
        console.log(`👁️ Starting IDLE monitoring for ${account.imap_user}`);
        
        // Set up exists event listener for new emails
        client.on("exists", async (data) => {
          console.log(`📬 New email notification for ${account.imap_user}`);
          // Perform incremental sync when new email arrives
          setTimeout(() => this.performSync(account, client), 1000);
        });

        // Gmail/IMAP requires IDLE to be renewed every 29 minutes
        const idleRenewal = setInterval(async () => {
          try {
            // End IDLE and restart to keep connection alive
            lock.release();
            await new Promise(resolve => setTimeout(resolve, 100));
            const newLock = await client.getMailboxLock("INBOX");
            console.log(`🔄 IDLE renewed for ${account.imap_user}`);
          } catch (err) {
            console.error(`❌ IDLE renewal error for ${account.imap_user}:`, err.message);
          }
        }, 28 * 60 * 1000); // 28 minutes

        // Store renewal interval for cleanup
        this.clients.get(accountId).idleRenewal = idleRenewal;

      } finally {
        // Don't release lock here - keep it for IDLE
      }

    } catch (error) {
      console.error(`❌ IDLE monitoring error for ${account.imap_user}:`, error.message);
      // Retry IDLE
      setTimeout(() => this.startIdleMonitoring(account, client), 5000);
    }
  }

  /**
   * Fetch and index emails
   */
  async fetchAndIndexEmails(account, client, uids) {
    const emails = [];

    for await (let msg of client.fetch(uids, { 
      source: true, 
      flags: true,
      envelope: true 
    })) {
      try {
        const parsed = await simpleParser(msg.source);
        
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

        const email = {
          from: parsed.from?.text || "",
          subject: parsed.subject || "",
          date: parsed.date || new Date(),
          body: htmlBody,
          uid: msg.uid,
          messageId: parsed.messageId || `${msg.uid}@${account.imap_user}`,
          flags: msg.flags,
          seen: msg.flags?.has('\\Seen') || false,
        };

        emails.push(email);
      } catch (err) {
        console.error(`⚠️ Failed to parse email UID ${msg.uid}:`, err.message);
      }
    }

    console.log(`✅ Fetched and parsed ${emails.length} emails`);

    // Classify and index emails
    if (emails.length > 0) {
      await this.indexEmails(account, emails);
    }
  }

  /**
   * Index emails in Elasticsearch
   */
  async indexEmails(account, emails) {
    const enrichedEmails = emails.map((email) => {
      const bodyText = htmlToText(email.body || "", { 
        wordwrap: 130, 
        ignoreHref: true, 
        ignoreImage: true 
      }).replace(/\s+/g, " ").trim();

      let label = "Unclassified";
      try {
        label = classifyEmail({ ...email, body: bodyText });
      } catch (err) {
        console.warn(`⚠️ Classification failed for "${email.subject}"`);
      }

      const emailId = crypto.createHash("md5")
        .update((email.subject || "") + (email.date || "") + account.imap_user)
        .digest("hex");

      return {
        _id: emailId,
        from: email.from,
        subject: email.subject,
        body_html: email.body,
        body_text: bodyText,
        date: email.date,
        messageId: email.messageId,
        label,
        account_id: account._id.toString(),
        imap_user: account.imap_user,
        seen: email.seen,
        uid: email.uid,
      };
    });

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
        imap_user: email.imap_user,
        seen: email.seen,
        uid: email.uid,
      }
    ]);

    try {
      const bulkResponse = await esClient.bulk({ refresh: true, operations: bulkOps });
      if (bulkResponse.errors) {
        console.error("❌ Some emails failed to index");
      } else {
        console.log(`✅ Indexed ${enrichedEmails.length} emails for ${account.imap_user}`);
      }
    } catch (error) {
      console.error(`❌ Failed to index emails:`, error.message);
    }
  }

  /**
   * Stop sync for an account
   */
  async stopSync(accountId) {
    const client = this.clients.get(accountId);
    if (client) {
      try {
        if (client.idleRenewal) {
          clearInterval(client.idleRenewal);
        }
        await client.logout();
        console.log(`🛑 Stopped sync for account ${accountId}`);
      } catch (err) {
        console.error(`❌ Error stopping sync:`, err.message);
      }
      this.clients.delete(accountId);
    }
  }

  /**
   * Stop all syncs
   */
  async stopAllSyncs() {
    const accountIds = Array.from(this.clients.keys());
    for (const accountId of accountIds) {
      await this.stopSync(accountId);
    }
  }
}

// Create singleton instance
const imapSyncService = new ImapSyncService();

module.exports = imapSyncService;
