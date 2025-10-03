const express = require("express");
const router = express.Router();
const Account = require("../models/user");
const imapSyncService = require("../services/imapSync");

router.post("/login", async (req, res) => {
  const { imap_user, imap_pass } = req.body;
  if (!imap_user || !imap_pass) return res.status(400).json({ error: "imap_user and imap_pass required" });

  try {
    let account = await Account.findOne({ imap_user });
    if (!account) {
      account = await Account.create({ imap_user, imap_pass });
    } else {
      // Update password if it changed
      if (account.imap_pass !== imap_pass) {
        account.imap_pass = imap_pass;
        await account.save();
      }
    }

    // Start IMAP sync for this account
    imapSyncService.startSync(account).catch(err => {
      console.error(`❌ Failed to start sync on login:`, err.message);
    });

    res.json({ message: `IMAP sync started for ${imap_user}`, account });
  } catch (error) {
    console.error(`❌ Login error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
