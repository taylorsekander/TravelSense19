/**
 * netlify/functions/chat.js
 *
 * Server-side proxy for the Anthropic Messages API.
 *
 * The API key is read from ANTHROPIC_API_KEY and never reaches the browser.
 * The front end posts to /.netlify/functions/chat.
 *
 * Set the key once in Netlify:
 *   Site configuration > Environment variables
 *     ANTHROPIC_API_KEY = your key
 *   Then redeploy — Netlify does not apply new variables to an existing deploy.
 *
 * Locally:  ANTHROPIC_API_KEY=sk-ant-... netlify dev
 *
 * AI ANALYTICS: every request emits one structured JSON line to the function
 * log (Netlify dashboard > Logs > Functions). Filter on "ts_metrics" to pull
 * token usage, estimated cost, latency, retries and errors. None of this is
 * ever returned to the browser.
 */

const UPSTREAM = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const RETRY_ONCE_ON = new Set([429, 500, 502, 503, 504, 529]);
const RETRY_DELAY_MS = 1200;

// Approximate per-million-token pricing, USD. Adjust if your rates differ.
const PRICING = {
  default: { input: 3.0, output: 15.0 },
  haiku: { input: 0.8, output: 4.0 },
  opus: { input: 15.0, output: 75.0 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const reply = (statusCode, payload) => ({ statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) });
const errorReply = (statusCode, message) => reply(statusCode, { error: { message } });

function priceFor(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("haiku")) return PRICING.haiku;
  if (m.includes("opus")) return PRICING.opus;
  return PRICING.default;
}

function estimateCost(model, usage) {
  if (!usage) return 0;
  const p = priceFor(model);
  const inTok = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const outTok = usage.output_tokens || 0;
  return Number(((inTok / 1e6) * p.input + (outTok / 1e6) * p.output).toFixed(6));
}

/** One structured line per request. Never sent to the client. */
function logMetrics(m) {
  try {
    console.log("ts_metrics " + JSON.stringify(m));
  } catch (e) {
    /* logging must never break the request */
  }
}

/**
 * Send the same metrics to GA4 via the Measurement Protocol, so cost shows up
 * alongside the browser's events in one property.
 *
 * Requires two Netlify environment variables:
 *   GA4_MEASUREMENT_ID  - e.g. G-32SNHPSVGG
 *   GA4_API_SECRET      - GA4 > Admin > Data streams > your stream >
 *                         Measurement Protocol API secrets > Create
 *
 * If either is missing this quietly does nothing, so the app runs fine
 * without them. Failures here never affect the user's request.
 */
async function sendToGA4(clientId, metrics) {
  const id = process.env.GA4_MEASUREMENT_ID;
  const secret = process.env.GA4_API_SECRET;
  if (!id || !secret) return;

  const params = {
    kind: metrics.kind || "unknown",
    model: String(metrics.model || ""),
    ok: metrics.ok ? 1 : 0,
    api_cost: Number(metrics.est_cost_usd || 0),
    total_tokens: Number(metrics.total_tokens || 0),
    input_tokens: Number(metrics.input_tokens || 0),
    output_tokens: Number(metrics.output_tokens || 0),
    latency_ms: Number(metrics.ms || 0),
    retries: Number(metrics.retries || 0),
    truncated: metrics.truncated ? 1 : 0,
    error_type: String(metrics.error || "none"),
    engagement_time_msec: 1,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(
      "https://www.google-analytics.com/mp/collect?measurement_id=" +
        encodeURIComponent(id) + "&api_secret=" + encodeURIComponent(secret),
      {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          client_id: String(clientId || "server"),
          non_personalized_ads: true,
          events: [{ name: "claude_api_call", params }],
        }),
      }
    );
  } catch (e) {
    // Analytics must never break the request. Swallow it.
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  const startedAt = Date.now();

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "POST, OPTIONS",
      },
      body: "",
    };
  }
  if (event.httpMethod !== "POST") {
    return errorReply(405, "This endpoint only accepts POST requests.");
  }

  // ---- signup capture -------------------------------------------------
  // Beta signups are POSTed here so they land somewhere the founder can read,
  // rather than sitting in the tester's own browser. Handled before the API
  // key check because collecting a signup must not depend on Anthropic.
  let earlyPayload = null;
  try {
    earlyPayload = JSON.parse(event.body || "{}");
  } catch (err) {
    return errorReply(400, "Request body was not valid JSON.");
  }

  if (earlyPayload && earlyPayload.type === "signup") {
    const s = earlyPayload.signup || {};
    const email = String(s.email || "").trim();
    const name = String(s.name || "").trim();
    if (!email || email.indexOf("@") < 0) {
      return errorReply(400, "A valid email is required.");
    }
    // One line per signup. Retrieve with: Netlify > Logs > Functions,
    // filtering on "ts_signup".
    try {
      console.log(
        "ts_signup " +
          JSON.stringify({
            email,
            name,
            at: s.at || new Date().toISOString(),
            source: s.source || "unknown",
            cid: String(earlyPayload.cid || "unknown"),
          })
      );
    } catch (e) {}
    return reply(200, { ok: true });
  }
  // ---------------------------------------------------------------------

  // ---- tts availability check -------------------------------------------
  // Lets the browser know whether neural speech is configured without
  // synthesizing anything, so no characters are consumed.
  if (earlyPayload && earlyPayload.type === "tts_status") {
    return reply(200, {
      available: !!process.env.GOOGLE_TTS_API_KEY,
      voice: process.env.GOOGLE_TTS_VOICE || "en-GB-Chirp3-HD-Puck",
    });
  }

  // ---- text to speech ---------------------------------------------------
  // Google Cloud Text-to-Speech, Chirp 3 HD. Handled before the Anthropic key
  // check because speech must not depend on the chat model.
  //
  // Requires in Netlify:
  //   GOOGLE_TTS_API_KEY  - Google Cloud console > APIs & Services >
  //                         Credentials > Create API key, with the
  //                         Cloud Text-to-Speech API enabled
  // Optional:
  //   GOOGLE_TTS_VOICE    - defaults to a British male Chirp 3 HD voice
  //
  // If the key is absent this returns 503 and the browser falls back to the
  // device voice, so the app still works without it.
  if (earlyPayload && earlyPayload.type === "tts") {
    const ttsKey = process.env.GOOGLE_TTS_API_KEY;
    if (!ttsKey) {
      return reply(503, { error: { message: "TTS not configured" }, fallback: true });
    }
    const text = String(earlyPayload.text || "").slice(0, 1200);
    if (!text.trim()) return errorReply(400, "No text supplied.");

    const voiceName = process.env.GOOGLE_TTS_VOICE || "en-GB-Chirp3-HD-Puck";
    const langCode = voiceName.slice(0, 5);
    const ttsStarted = Date.now();

    try {
      const r = await fetch(
        "https://texttospeech.googleapis.com/v1/text:synthesize?key=" +
          encodeURIComponent(ttsKey),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: { text },
            voice: { languageCode: langCode, name: voiceName },
            audioConfig: {
              audioEncoding: "MP3",
              speakingRate: 0.98,
              // Chirp 3 HD ignores pitch; kept for other voice families.
              effectsProfileId: ["headphone-class-device"],
            },
          }),
        }
      );
      const bodyText = await r.text();
      if (!r.ok) {
        let msg = "";
        try { msg = JSON.parse(bodyText).error.message || ""; } catch (e) {}
        logMetrics({
          ok: false, kind: "tts", error: "status_" + r.status,
          ms: Date.now() - ttsStarted, chars: text.length,
        });
        // Any failure tells the browser to use its own voice instead.
        return reply(r.status === 429 ? 429 : 502, {
          error: { message: msg || "Speech synthesis failed." }, fallback: true,
        });
      }
      const parsed = JSON.parse(bodyText);
      logMetrics({
        ok: true, kind: "tts", voice: voiceName,
        ms: Date.now() - ttsStarted, chars: text.length,
        // Chirp 3 HD list price, USD per million characters.
        est_cost_usd: Number(((text.length / 1e6) * 30).toFixed(6)),
      });
      return reply(200, { audio: parsed.audioContent, voice: voiceName });
    } catch (err) {
      logMetrics({ ok: false, kind: "tts", error: "network", ms: Date.now() - ttsStarted });
      return reply(502, { error: { message: "Could not reach the speech service." }, fallback: true });
    }
  }
  // ---------------------------------------------------------------------

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logMetrics({ ok: false, error: "missing_key", ms: Date.now() - startedAt });
    return errorReply(
      500,
      "ANTHROPIC_API_KEY is not configured on the server. Add it in Netlify under Site configuration > Environment variables, then redeploy."
    );
  }

  const payload = earlyPayload || {};
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return errorReply(400, "Request must include a non-empty messages array.");
  }

  const model = payload.model;
  const body = JSON.stringify({
    model,
    max_tokens: payload.max_tokens || 2000,
    system: payload.system,
    messages: payload.messages,
  });

  // Rough classification so logs separate conversation turns from
  // recommendation reasoning — they have very different cost profiles.
  const kind = /Why we picked this/.test(payload.system || "") ? "reasons" : "conversation";
  const clientId = payload.cid || "server";

  let retries = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await fetch(UPSTREAM, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body,
      });
    } catch (err) {
      if (attempt === 1) {
        retries++;
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      logMetrics({ ok: false, kind, model, error: "network", retries, ms: Date.now() - startedAt });
      return errorReply(502, "Could not reach Claude. Please try again in a moment.");
    }

    const text = await res.text();

    if (res.ok) {
      let usage = null;
      let stopReason = null;
      try {
        const parsed = JSON.parse(text);
        usage = parsed.usage || null;
        stopReason = parsed.stop_reason || null;
      } catch (e) {}
      const metrics = {
        ok: true,
        kind,
        model,
        ms: Date.now() - startedAt,
        retries,
        stop_reason: stopReason,
        input_tokens: usage ? usage.input_tokens : null,
        output_tokens: usage ? usage.output_tokens : null,
        total_tokens: usage ? (usage.input_tokens || 0) + (usage.output_tokens || 0) : null,
        est_cost_usd: estimateCost(model, usage),
        truncated: stopReason === "max_tokens",
      };
      logMetrics(metrics);
      await sendToGA4(clientId, metrics);
      return { statusCode: 200, headers: JSON_HEADERS, body: text };
    }

    if (RETRY_ONCE_ON.has(res.status) && attempt === 1) {
      retries++;
      logMetrics({ ok: false, kind, model, error: "retryable_" + res.status, retries, ms: Date.now() - startedAt });
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    let upstreamMessage = "";
    try {
      const parsed = JSON.parse(text);
      upstreamMessage = (parsed && parsed.error && parsed.error.message) || "";
    } catch (e) {}

    const failMetrics = { ok: false, kind, model, error: "status_" + res.status, retries, ms: Date.now() - startedAt };
    logMetrics(failMetrics);
    await sendToGA4(clientId, failMetrics);

    if (res.status === 401 || res.status === 403) {
      return errorReply(res.status, "The server's API key was rejected. Check ANTHROPIC_API_KEY in Netlify.");
    }
    if (res.status === 429) return errorReply(429, "Rate limit reached. Please wait a few seconds and try again.");
    if (res.status === 529) return errorReply(529, "Claude is temporarily overloaded. Please try again shortly.");
    if (res.status === 400) return errorReply(400, upstreamMessage || "Claude rejected that request.");
    if (res.status >= 500) return errorReply(502, "Claude had a server error. Please try again in a moment.");
    return errorReply(res.status, upstreamMessage || `Request failed with status ${res.status}.`);
  }

  logMetrics({ ok: false, kind, model, error: "exhausted", retries, ms: Date.now() - startedAt });
  return errorReply(502, "Request failed after retrying. Please try again.");
};
