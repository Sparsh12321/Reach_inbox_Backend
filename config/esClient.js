const { Client } = require("@elastic/elasticsearch");

const client = new Client({
  node: process.env.ELASTIC_URL,
  auth: {
    apiKey: process.env.ELASTIC_API
  },
});

async function ensureIndex() {
  const indexName = "emails";
  const exists = await esClient.indices.exists({ index: indexName });

  if (!exists) {
    await esClient.indices.create({
      index: indexName,
      body: {
        mappings: {
          properties: {
            from: { type: "text" },
            subject: { type: "text" },
            body_html: { type: "text" },
            body_text: { type: "text" },
            date: { type: "date" },
            messageId: { type: "keyword" },
            label: { type: "keyword" },
            account_id: { type: "keyword" },
            imap_user: { type: "keyword" },
          },
        },
      },
    });
    console.log("✅ Created 'emails' index in Elasticsearch");
  } else {
    console.log("ℹ️ 'emails' index already exists");
  }
}

// Immediately ensure index on import
ensureIndex().catch((err) => console.error("❌ Elasticsearch index setup failed:", err));

module.exports = client;
