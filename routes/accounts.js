const express = require("express");
const router = express.Router();
const Account = require("../models/user");
const imapSyncService = require("../services/imapSync");

router.get("/", async (req, res) => {
  const accounts = await Account.find();
  res.json({ accounts });
});

router.post("/switch-account", async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: "accountId is required" });

    const account = await Account.findById(accountId);
    if (!account) return res.status(404).json({ error: "Account not found" });

    // Start sync for switched account
    await imapSyncService.startSync(account);

    res.json({ message: `IMAP sync started for ${account.imap_user}`, account });
  } catch (error) {
    console.error(`❌ Switch account error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post("/reset-sync", async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: "accountId is required" });

    const account = await Account.findById(accountId);
    if (!account) return res.status(404).json({ error: "Account not found" });
    
    // Stop and restart sync (forces full resync)
    await imapSyncService.stopSync(accountId);
    await imapSyncService.startSync(account);
    
    res.json({ message: `Sync reset and restarted for ${account.imap_user}` });
  } catch (error) {
    console.error(`❌ Reset sync error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
