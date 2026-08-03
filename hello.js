/**
 * netlify/functions/hello.js
 *
 * DIAGNOSTIC ONLY — safe to delete once things work.
 *
 * This function has no dependencies, no environment variables, and no network
 * calls. Its only job is to answer the question: "do functions deploy on this
 * site at all?"
 *
 * Visit:  https://YOUR-SITE.netlify.app/.netlify/functions/hello
 *
 *   You see JSON            -> functions DO deploy. The problem is specific
 *                              to chat.js or its ANTHROPIC_API_KEY.
 *   You see 404 / Not Found -> functions are NOT deploying at all. The problem
 *                              is the repo layout or the build config, not the
 *                              chat function.
 */

exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(
      {
        ok: true,
        message: "Functions are deploying correctly on this site.",
        nodeVersion: process.version,
        // Confirms the key is present WITHOUT revealing it.
        anthropicKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
        anthropicKeyLength: process.env.ANTHROPIC_API_KEY
          ? String(process.env.ANTHROPIC_API_KEY).length
          : 0,
        globalFetchAvailable: typeof fetch === "function",
        timestamp: new Date().toISOString(),
      },
      null,
      2
    ),
  };
};
