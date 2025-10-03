const express = require("express");
const cors = require("cors");
require("dotenv").config();
require("./services/classifier"); // load classifier
require("./config/esClient");     // ensure ES client ready

const authRoutes = require("./routes/auth");
const accountsRoutes = require("./routes/accounts");
const emailsRoutes = require("./routes/emails");
const imapSyncService = require("./services/imapSync");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Routes
app.use("/auth", authRoutes);
app.use("/accounts", accountsRoutes);
app.use("/emails", emailsRoutes);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  await imapSyncService.stopAllSyncs();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  await imapSyncService.stopAllSyncs();
  process.exit(0);
});

app.listen(3000, () => console.log("🚀 Server running on http://localhost:3000"));
