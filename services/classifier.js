const { loadClassifier: loadModel } = require("../utils/classifier");

let classifierReady = false;

(async () => {
  try {
    await loadModel();
    classifierReady = true;
    console.log("✅ Classifier loaded and ready");
  } catch (err) {
    console.error("❌ Error loading classifier:", err.message);
  }
})();

function classifyEmailWrapper(email) {
  if (!classifierReady) return "Unclassified";
  return require("../utils/classifier").classifyEmail(email);
}

module.exports = { classifierReady, classifyEmail: classifyEmailWrapper };
