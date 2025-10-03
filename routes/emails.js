const express = require("express");
const router = express.Router();
const esClient = require("../config/esClient");

router.get("/search", async (req, res) => {
  try {
    const { q, account_id } = req.query;
    if (!q) return res.status(400).json({ error: "Query missing" });

    let query;
    if (q === "*" || q === "from:*") {
      query = account_id ? { bool: { must: { match_all: {} }, filter: { term: { account_id } } } } : { match_all: {} };
    } else {
      const textQuery = { multi_match: { query: q, fields: ["from","subject","body_text","label"], fuzziness: "AUTO" } };
      query = account_id ? { bool: { must: textQuery, filter: { term: { account_id } } } } : textQuery;
    }

    console.log("🔍 Email search query:", JSON.stringify(query, null, 2));
    const result = await esClient.search({ index: "emails", query, size: 1000, sort: [{ date: { order: "desc" } }] });
    console.log(`✅ Found ${result.hits.hits.length} emails`);
    res.json({ emails: result.hits.hits.map(h => h._source) });
  } catch (error) {
    console.error("❌ Error searching emails:", error);
    res.status(500).json({ error: error.message, emails: [] });
  }
});

router.get("/debug/emails-count", async (req, res) => {
  try {
    const count = await esClient.count({ index: "emails" });
    const sample = await esClient.search({ index: "emails", query: { match_all: {} }, size: 5, sort: [{ date: { order: "desc" } }] });
    res.json({ total: count.count, sampleEmails: sample.hits.hits.map(h => h._source) });
  } catch (error) {
    console.error("❌ Error in debug endpoint:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const { accountId } = req.body;
    
    if (!accountId) {
      return res.status(400).json({ error: "accountId is required" });
    }

    const Account = require("../models/user");
    const imapSyncService = require("../services/imapSync");
    
    const account = await Account.findById(accountId);
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    // Trigger a manual sync
    await imapSyncService.performSync(account, imapSyncService.clients.get(accountId));
    
    res.json({ message: "Email sync triggered successfully" });
  } catch (error) {
    console.error("❌ Error refreshing emails:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
