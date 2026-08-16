/**
 * BACKGROUND SERVICE WORKER — Travel Spots Collector
 *
 * Handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube transcripts via Supadata API
 * 3. Calling DeepSeek to extract travel spots, routes, and hotels
 * 4. Saving / retrieving timestamped notes
 */

importScripts("settings.js");

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS   = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS   = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => { if (DEBUG) console.log(...args); };

chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((err) => console.warn("[TSC] Could not restrict storage access:", err));

// ============================================================
// SETTINGS
// ============================================================

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

// ============================================================
// PROMPT LOADING
// ============================================================

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) throw new Error(`Could not load prompt file: ${fileName}`);
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker      = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) throw new Error(`Prompt section not found: ${fileName}#${heading}`);

  const sectionStart = markerIndex + marker.length;
  const nextSection  = markdown.indexOf("\n## ", sectionStart);
  const section      = markdown.slice(sectionStart, nextSection === -1 ? markdown.length : nextSection);

  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) throw new Error(`Prompt fence not found: ${fileName}#${heading}`);

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

// ============================================================
// AI COMPLETION
// ============================================================

async function requestAiCompletion({ messages, maxTokens, temperature, responseFormat }) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    const error = new Error("DeepSeek API key not configured. Open Settings.");
    error.code = "NO_AI_KEY";
    throw error;
  }

  const body = { model: settings.aiModel, max_tokens: maxTokens, messages };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) body.response_format = responseFormat;
  body.thinking = { type: "disabled" };

  const controller    = new AbortController();
  let timeoutKind     = "";
  let idleTimeoutId;
  let hardTimeoutId;

  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(() => abortForTimeout("idle"), AI_PROVIDER_IDLE_TIMEOUT_MS);
  };

  hardTimeoutId = setTimeout(() => abortForTimeout("hard"), AI_PROVIDER_HARD_TIMEOUT_MS);
  resetIdleTimeout();

  try {
    const response = await fetch(YTD_SETTINGS.chatCompletionsUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.aiApiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    resetIdleTimeout();

    const data = await readBoundedAiResponse(response, resetIdleTimeout);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(errorData.error?.message || errorData.message || `DeepSeek error: ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("DeepSeek returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const e = new Error("DeepSeek request was inactive for 50 seconds. Please Retry.");
      e.code = "AI_IDLE_TIMEOUT";
      throw e;
    }
    if (timeoutKind === "hard") {
      const e = new Error("DeepSeek request exceeded the 120-second limit. Please Retry.");
      e.code = "AI_HARD_TIMEOUT";
      throw e;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      responseBytes += value?.byteLength ?? 0;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    if (new TextEncoder().encode(responseText).byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("DeepSeek response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel.html", enabled: true });
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

function updatePanelForTab(tabId, url) {
  const isYouTube = (url || "").startsWith("https://www.youtube.com");
  chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: isYouTube }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  updatePanelForTab(tabId, changeInfo.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updatePanelForTab(tabId, tab.url);
  } catch (e) {}
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.action === "seekInYouTube") {
    (async () => {
      try {
        // Find any YouTube tab — don't rely on active/focused window
        let tabs = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" });
        if (!tabs.length) tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
        if (tabs.length) {
          await chrome.tabs.sendMessage(tabs[0].id, { action: "seekTo", seconds: message.seconds });
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: "No YouTube tab found" });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === "fetchTranscript") {
    handleFetchTranscript(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "extractSpots") {
    handleExtractSpots(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    handleSaveNote(message.videoId, message.timestamp, message.videoTitle, message.channelName, message.spotName)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) => sendResponse({
        hasSupadataKey: !!settings.supadataApiKey,
        hasAiKey:       !!settings.aiApiKey,
      }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
      chrome.sidePanel.open({ tabId })
        .then(() => {
          setTimeout(() => {
            chrome.runtime.sendMessage({ action: "startDigestFromButton" }).catch(() => {});
          }, 300);
        })
        .catch((err) => console.error("[TSC BG] openSidePanel error:", err));
    } else {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
        if (tabs[0]) {
          chrome.sidePanel.setOptions({ tabId: tabs[0].id, path: "sidepanel.html", enabled: true });
          chrome.sidePanel.open({ tabId: tabs[0].id }).catch(() => {});
        }
      });
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "relayToContent") {
    (async () => {
      try {
        let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tabs[0] || !tabs[0].url?.includes("youtube.com")) {
          tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*", active: true });
        }
        if (!tabs[0]) {
          tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
        }

        if (tabs[0]) {
          let response = await chrome.tabs.sendMessage(tabs[0].id, message.payload);

          if (message.payload?.action === "getVideoInfo") {
            const playerInfo = await getPlayerVideoDetails(tabs[0].id);
            if (playerInfo) {
              response = {
                title:       playerInfo.title       || response?.title       || "",
                channelName: playerInfo.channelName || response?.channelName || "",
                duration:    playerInfo.duration    || response?.duration    || 0,
                description: playerInfo.description || response?.description || "",
              };
            }
          }

          sendResponse({ success: true, response });
        } else {
          sendResponse({ success: false, error: "No YouTube tab found" });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});

async function getPlayerVideoDetails(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const player  = document.getElementById("movie_player");
          const details = player?.getPlayerResponse?.()?.videoDetails;
          if (!details) return null;
          return {
            title:       details.title            || "",
            channelName: details.author           || "",
            description: details.shortDescription || "",
            duration:    Number(details.lengthSeconds) || 0,
          };
        } catch { return null; }
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[TSC BG] Player details unavailable:", e.message);
    return null;
  }
}

// ============================================================
// TRANSCRIPT FETCHING (YouTube built-in → Supadata fallback)
// ============================================================

async function handleFetchTranscript(videoId) {
  // 1. Try YouTube's own built-in captions first — free, no API key needed
  debugLog("[TSC] Trying YouTube built-in captions…");
  const ytResult = await fetchYouTubeCaptions(videoId);
  if (ytResult.success) {
    debugLog("[TSC] YouTube built-in captions succeeded");
    return ytResult;
  }
  debugLog("[TSC] YouTube captions unavailable:", ytResult.error, "— trying Supadata");

  // 2. Fall back to Supadata
  try {
    const settings = await getSettings();
    if (!settings.supadataApiKey) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "No captions found on YouTube for this video. Add a Supadata key in Settings to enable a fallback.",
      };
    }

    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    const apiUrl = new URL("https://api.supadata.ai/v1/transcript");
    apiUrl.searchParams.set("url", canonicalVideoUrl);
    apiUrl.searchParams.set("text", "false");
    apiUrl.searchParams.set("lang", "en");
    apiUrl.searchParams.set("mode", "native");

    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      headers: { "x-api-key": settings.supadataApiKey },
    });

    if (response.status === 202) {
      const jobData = await response.json();
      return await pollTranscriptJob(jobData.jobId, settings.supadataApiKey);
    }

    if (response.status === 206) {
      return { success: false, error: "NO_TRANSCRIPT", message: "No native subtitle track available for this video." };
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 401) return { success: false, error: "INVALID_SUPADATA_KEY", message: "Your Supadata API key is invalid." };
      if (response.status === 404) return { success: false, error: "NO_TRANSCRIPT",         message: "No subtitles found for this video." };
      if (response.status === 429) return { success: false, error: "RATE_LIMITED",           message: "Supadata rate limit reached. Wait a minute and try again." };
      throw new Error(errorData.message || `Supadata API error: ${response.status}`);
    }

    const data = await response.json();
    return parseSupadataTranscript(data);
  } catch (error) {
    console.error("Transcript fetch error:", error);
    return { success: false, error: error.message || "Failed to fetch transcript" };
  }
}

// ──────────────────────────────────────────────────────────────
// YouTube built-in captions
// ──────────────────────────────────────────────────────────────

async function fetchYouTubeCaptions(videoId) {
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "Accept-Language": "en-US,en;q=0.9" },
    });
    if (!response.ok) throw new Error(`YouTube page fetch failed: ${response.status}`);

    const html = await response.text();

    // Find the captionTracks array inside ytInitialPlayerResponse
    const marker = '"captionTracks":';
    const markerIdx = html.indexOf(marker);
    if (markerIdx === -1) {
      return { success: false, error: "NO_CAPTIONS", message: "This video has no captions." };
    }

    const arrayStart = html.indexOf("[", markerIdx + marker.length);
    if (arrayStart === -1) throw new Error("Malformed captionTracks data");

    // Balance brackets to extract the full array
    let depth = 0;
    let arrayEnd = arrayStart;
    for (let i = arrayStart; i < html.length; i++) {
      const ch = html[i];
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) { arrayEnd = i; break; }
      }
    }

    const captionTracks = JSON.parse(html.slice(arrayStart, arrayEnd + 1));
    if (!captionTracks.length) {
      return { success: false, error: "NO_CAPTIONS", message: "This video has no captions." };
    }

    // Prefer manual English → auto-generated English → any track
    const track =
      captionTracks.find(t => t.languageCode === "en" && !t.kind) ||
      captionTracks.find(t => t.languageCode === "en") ||
      captionTracks[0];

    const captionUrl = track.baseUrl + "&fmt=json3";
    const capResponse = await fetch(captionUrl);
    if (!capResponse.ok) throw new Error(`Caption fetch failed: ${capResponse.status}`);

    const capData = await capResponse.json();
    return parseYouTubeCaptionsJson3(capData, track.languageCode);
  } catch (error) {
    debugLog("[TSC] YouTube captions error:", error.message);
    return { success: false, error: "YOUTUBE_CAPTIONS_FAILED", message: error.message };
  }
}

function parseYouTubeCaptionsJson3(data, languageCode) {
  const transcript = [];
  let transcriptTextPlain = "";
  let transcriptTextTimestamped = "";

  for (const event of (data.events || [])) {
    if (!event.segs) continue;
    const text = event.segs.map(s => s.utf8 || "").join("").replace(/\n/g, " ").trim();
    if (!text) continue;

    const startSeconds = Math.floor((event.tStartMs || 0) / 1000);
    const minutes = Math.floor(startSeconds / 60);
    const seconds = startSeconds % 60;
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    transcript.push({
      text,
      start:    startSeconds,
      duration: Math.floor((event.dDurationMs || 0) / 1000),
      language: languageCode || null,
    });
    transcriptTextPlain       += text + " ";
    transcriptTextTimestamped += `[${timestamp}] ${text}\n`;
  }

  if (transcript.length === 0) {
    return { success: false, error: "EMPTY_CAPTIONS", message: "YouTube captions are empty for this video." };
  }

  return {
    success:                  true,
    source:                   "youtube",
    transcript,
    transcriptText:            transcriptTextPlain.trim(),
    transcriptTextTimestamped: transcriptTextTimestamped.trim(),
    language:                  languageCode || null,
  };
}

function parseSupadataTranscript(data) {
  const transcript = [];
  let transcriptTextPlain       = "";
  let transcriptTextTimestamped = "";

  if (data.content && Array.isArray(data.content)) {
    for (const chunk of data.content) {
      if (chunk.text) {
        const cleanText = chunk.text.replace(/>> ?/g, "").trim();
        if (!cleanText) continue;

        const startSeconds = Math.floor((chunk.offset || 0) / 1000);
        const minutes = Math.floor(startSeconds / 60);
        const seconds = startSeconds % 60;
        const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

        transcript.push({
          text:     cleanText,
          start:    startSeconds,
          duration: Math.floor((chunk.duration || 0) / 1000),
          language: chunk.lang || data.lang || null,
        });
        transcriptTextPlain       += cleanText + " ";
        transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
      }
    }
  }

  if (transcript.length === 0) {
    return { success: false, error: "EMPTY_TRANSCRIPT", message: "Supadata returned an empty transcript for this video." };
  }

  return {
    success: true,
    transcript,
    transcriptText:            transcriptTextPlain.trim(),
    transcriptTextTimestamped: transcriptTextTimestamped.trim(),
    language:                  typeof data.lang === "string" ? data.lang : null,
  };
}

async function pollTranscriptJob(jobId, supadataApiKey) {
  const maxAttempts = 60;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const response = await fetch(
      `https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`,
      { headers: { "x-api-key": supadataApiKey } },
    );

    if (!response.ok) throw new Error(`Job polling failed: ${response.status}`);

    const data = await response.json();
    if (data.status === "completed") return parseSupadataTranscript(data);
    if (data.status === "failed")    throw new Error("Transcript processing failed");
  }
  throw new Error("Transcript processing timed out");
}

// ============================================================
// JSON HELPER
// ============================================================

function parseLooseJson(text) {
  let cleaned = (text || "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace  = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return JSON.parse(cleaned.replace(/,(\s*[}\]])/g, "$1"));
  }
}

// ============================================================
// SPOT EXTRACTION (DeepSeek)
// ============================================================

async function handleExtractSpots(transcriptText, videoTitle, channelName, videoDescription) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "NO_AI_KEY", message: "DeepSeek API key not configured. Open Settings." };
    }

    const variables = {
      videoTitle:       videoTitle       || "Unknown",
      channelName:      channelName      || "Unknown",
      transcriptText:   transcriptText   || "",
      videoDescription: videoDescription || "",
    };

    const systemPrompt = await loadPromptSection("travel.md", "System prompt", variables);
    const userPrompt   = await loadPromptSection("travel.md", "User prompt",   variables);

    debugLog("[TSC] Requesting spot extraction");
    const { text: responseText } = await requestAiCompletion({
      maxTokens:      4096,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
    });

    const parsed = parseLooseJson(responseText);

    const safeStr = (v, max)  => typeof v === "string" ? v.trim().slice(0, max) : "";
    const safeInt = (v)       => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; };
    const VALID_CATS = ["restaurant","cafe","bar","bakery","market","attraction","museum","landmark","park","neighborhood","hotel","other"];

    const spots = (Array.isArray(parsed?.spots) ? parsed.spots : [])
      .slice(0, 60)
      .map((s) => ({
        name:              safeStr(s?.name,       200),
        local_name:        safeStr(s?.local_name, 200),
        category:          VALID_CATS.includes(s?.category) ? s.category : "other",
        timestamp_seconds: safeInt(s?.timestamp_seconds),
        note:              safeStr(s?.note, 500),
      }))
      .filter((s) => s.name);

    const route = (Array.isArray(parsed?.route) ? parsed.route : [])
      .slice(0, 30)
      .map((r, i) => ({
        order:      Number.isInteger(Number(r?.order)) ? Number(r.order) : i + 1,
        name:       safeStr(r?.name,       200),
        local_name: safeStr(r?.local_name, 200),
      }))
      .filter((r) => r.name)
      .sort((a, b) => a.order - b.order);

    const hotels = (Array.isArray(parsed?.hotels) ? parsed.hotels : [])
      .slice(0, 10)
      .map((h) => ({
        name:              safeStr(h?.name,       200),
        local_name:        safeStr(h?.local_name, 200),
        timestamp_seconds: safeInt(h?.timestamp_seconds),
        note:              safeStr(h?.note, 500),
      }))
      .filter((h) => h.name);

    return { success: true, spots, route, hotels };
  } catch (error) {
    console.error("[TSC] Extract spots error:", error);
    if (error.status === 401) return { success: false, error: "INVALID_AI_KEY", message: "DeepSeek rejected the API key." };
    if (error.status === 429) return { success: false, error: "RATE_LIMITED",   message: "DeepSeek rate-limited this request. Try again shortly." };
    return { success: false, error: error.message || "Failed to extract spots" };
  }
}

// ============================================================
// NOTE MANAGEMENT
// ============================================================

async function handleSaveNote(videoId, timestamp, videoTitle, channelName, spotName) {
  try {
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    const safeTimestamp     = Math.max(0, Math.floor(Number(timestamp) || 0));

    // Only use cached transcript for note context — never fetch fresh here,
    // as fetching is slow and note saving must be instant.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`digest_${videoId}`);
      if (cached[`digest_${videoId}`]?.transcript) {
        transcript = cached[`digest_${videoId}`].transcript;
      }
    } catch {}

    // Find transcript line near this timestamp for note text
    let matchedLine  = null;
    let beforeLine   = null;
    let afterLine    = null;
    let contextLines = [];

    if (transcript && transcript.length > 0) {
      for (let i = 0; i < transcript.length; i++) {
        const line = transcript[i];
        if (line.start <= safeTimestamp && (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)) {
          matchedLine = line;

          const beforeLines = [];
          for (let j = 1; j <= 2 && i - j >= 0; j++) beforeLines.unshift(transcript[i - j].text);
          if (beforeLines.length) beforeLine = beforeLines.join(" ");

          const afterLines = [];
          for (let j = 1; j <= 4 && i + j < transcript.length; j++) afterLines.push(transcript[i + j].text);
          if (afterLines.length) afterLine = afterLines.join(" ");

          const startIdx = Math.max(0, i - 8);
          const endIdx   = Math.min(transcript.length - 1, i + 12);
          for (let j = startIdx; j <= endIdx; j++) contextLines.push(transcript[j].text);
          break;
        }
      }

      if (!matchedLine) {
        matchedLine = transcript[transcript.length - 1];
        const startIdx = Math.max(0, transcript.length - 9);
        for (let j = startIdx; j < transcript.length; j++) contextLines.push(transcript[j].text);
      }
    }

    // If we have transcript context, try to clean up the note text with AI.
    // If not, save a plain timestamp marker so the note still lands.
    const cleanedText = matchedLine
      ? await cleanupNoteText(
          matchedLine.text, beforeLine, afterLine, contextLines.join(" "), videoTitle,
        )
      : `📍 Marked at ${Math.floor(safeTimestamp / 60)}:${String(safeTimestamp % 60).padStart(2, "0")}`;

    const minutes             = Math.floor(safeTimestamp / 60);
    const seconds             = safeTimestamp % 60;
    const formattedTimestamp  = `${minutes}:${String(seconds).padStart(2, "0")}`;
    const timestampedUrl      = `${canonicalVideoUrl}&t=${safeTimestamp}s`;

    const note = {
      id:               `note_${Date.now()}`,
      videoId,
      videoTitle:       typeof videoTitle   === "string" ? videoTitle.slice(0, 500)   : "Untitled Video",
      channelName:      typeof channelName  === "string" ? channelName.slice(0, 300)  : "",
      spotName:         typeof spotName     === "string" ? spotName.slice(0, 300)     : null,
      timestamp:        formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl,
      text:             cleanedText,
      rawText:          matchedLine?.text || cleanedText,
      createdAt:        Date.now(),
    };

    await saveNoteToStorage(note);
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});
    return { success: true, note };
  } catch (error) {
    console.error("[TSC] Save note error:", error);
    return { success: false, error: error.message };
  }
}

async function cleanupNoteText(targetText, beforeText, afterText, fullContext, videoTitle) {
  const settings = await getSettings();
  if (!settings.aiApiKey) return [beforeText, targetText, afterText].filter(Boolean).join(" ");

  try {
    const variables = {
      videoTitle:  videoTitle || "Unknown",
      fullContext,
      beforeText:  beforeText || "(none)",
      targetText,
      afterText:   afterText  || "(none)",
    };
    const systemPrompt = await loadPromptSection("note-cleanup.md", "System prompt", variables);
    const userPrompt   = await loadPromptSection("note-cleanup.md", "User prompt",   variables);

    const { text: resultText } = await requestAiCompletion({
      maxTokens:      512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
    });

    let result = resultText.trim() || targetText;
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch {
      result = result
        .replace(/^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i, "")
        .replace(/^(The cleaned (quote|text|version)( is)?:?\s*)/i, "")
        .replace(/^(I will.*?:?\s*)/i, "")
        .replace(/^(Cleaned:?\s*)/i, "")
        .replace(/^["']|["']$/g, "");
    }
    return result.slice(0, 3000);
  } catch {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }
}

async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes  = result.ytd_notes || [];
  notes.unshift(note);
  if (notes.length > 100) notes.splice(100);
  await chrome.storage.local.set({ ytd_notes: notes });
}

async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes    = result.ytd_notes || [];
    if (videoId) notes = notes.filter((n) => n.videoId === videoId);
    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes    = result.ytd_notes || [];
    notes        = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
