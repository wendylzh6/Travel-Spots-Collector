/**
 * SIDE PANEL — Travel Spots Collector
 *
 * Handles the UI: video detection, spot extraction, rendering, and notes.
 */

const DEBUG = false;
const debugLog = (...args) => { if (DEBUG) console.log(...args); };

// ============================================================
// STATE
// ============================================================

let currentVideoId   = null;
let currentVideoUrl  = null;
let currentSpots     = null;   // array of spot objects
let currentRoute     = null;   // array of route steps
let currentHotels    = null;   // array of hotel objects
let currentVideoTitle    = "";
let currentChannelName   = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let youtubeTabId = null;
let errorAction  = null;

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await evictOldCacheEntries(20);

  const configStatus = await chrome.runtime.sendMessage({ action: "checkConfig" });
  if (!configStatus.hasSupadataKey || !configStatus.hasAiKey) {
    showConfigError(configStatus);
    return;
  }

  await checkCurrentTab();
});

// Listen for messages from the Spots button on YouTube page
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "startDigestFromButton") {
    checkCurrentTab();
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved") {
    const filterAll = document.getElementById("notesFilterAll")?.classList.contains("active");
    loadNotes(filterAll ? null : currentVideoId);
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// TAB NAVIGATION — close panel when leaving YouTube
// ============================================================

let navigationRefreshTimer = null;
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => { panelWindowId = w.id; });

function scheduleDigestRefresh() {
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => checkCurrentTab(), 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

function handleFrontTabUrl(url) {
  if (!(url || "").startsWith("https://www.youtube.com")) {
    window.close();
    return;
  }
  const newVideoId = extractVideoId(url);
  if (newVideoId !== currentVideoId || !panelIsShowingResults()) {
    scheduleDigestRefresh();
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  handleFrontTabUrl(changeInfo.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    handleFrontTabUrl(tab.url || tab.pendingUrl || "");
  } catch (e) { /* tab closed */ }
});

// ============================================================
// EVENT LISTENERS
// ============================================================

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) { errorAction(); return; }
    if (currentVideoId) startDigest(currentVideoId, currentVideoUrl);
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  document.getElementById("exportSpotsBtn")?.addEventListener("click", exportSpotsList);

  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null);
  });
}

function setNotesFilter(showAll) {
  document.getElementById("notesFilterThis")?.classList.toggle("active", !showAll);
  document.getElementById("notesFilterThis")?.setAttribute("aria-pressed", String(!showAll));
  document.getElementById("notesFilterAll")?.classList.toggle("active", showAll);
  document.getElementById("notesFilterAll")?.setAttribute("aria-pressed", String(showAll));
}

function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === tabName)
  );
  document.querySelectorAll(".tab-panel").forEach((p) =>
    p.classList.toggle("active", p.dataset.panel === tabName)
  );
}

// ============================================================
// VIDEO DETECTION
// ============================================================

async function checkCurrentTab() {
  try {
    let tab = null;
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs[0]?.url?.includes("youtube.com")) tab = tabs[0];

    if (!tab) {
      tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*", active: true });
      if (tabs[0]) tab = tabs[0];
    }
    if (!tab) {
      tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
      if (tabs[0]) tab = tabs[0];
    }

    if (!tab?.url) { showState("welcome"); return; }

    youtubeTabId = tab.id;
    const videoId = extractVideoId(tab.url);

    if (videoId) {
      currentVideoUrl = tab.url;
      try {
        const result = await chrome.runtime.sendMessage({
          action: "relayToContent",
          payload: { action: "getVideoInfo" },
        });
        if (result.success && result.response) {
          currentVideoTitle       = result.response.title       || "";
          currentChannelName      = result.response.channelName || "";
          currentVideoDescription = result.response.description || "";
          currentVideoDuration    = result.response.duration    || 0;
        }
      } catch (e) {
        currentVideoTitle = currentChannelName = currentVideoDescription = "";
        currentVideoDuration = 0;
      }
      startDigest(videoId, tab.url);
    } else {
      showState("welcome");
    }
  } catch (error) {
    console.error("Tab check error:", error);
    showState("welcome");
  }
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com") && u.searchParams.has("v"))
      return u.searchParams.get("v");
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
    if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2];
    return null;
  } catch { return null; }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

async function startDigest(videoId, videoUrl) {
  // Already loaded this video
  if (videoId === currentVideoId && currentSpots !== null) {
    showState("results");
    updateVideoHeader();
    return;
  }

  // Check cache
  const cached = await loadFromCache(videoId);
  if (cached) {
    currentVideoId  = videoId;
    currentVideoUrl = videoUrl;
    currentSpots    = cached.spots  || [];
    currentRoute    = cached.route  || [];
    currentHotels   = cached.hotels || [];
    updateVideoHeader();
    renderSpots();
    renderRoute();
    showState("results");
    loadNotes(videoId);
    return;
  }

  // Fresh fetch
  currentVideoId  = videoId;
  currentVideoUrl = videoUrl;
  currentSpots    = null;
  currentRoute    = null;
  currentHotels   = null;

  updateVideoHeader();
  showState("loading");
  updateLoading("Fetching transcript", "Getting video captions…");

  const transcriptResult = await chrome.runtime.sendMessage({
    action: "fetchTranscript",
    videoId,
  });

  if (!transcriptResult.success) {
    if (transcriptResult.error === "NO_SUPADATA_KEY") {
      showError("API key missing", "Add your Supadata API key in Settings.");
      return;
    }
    showError("No transcript found", transcriptResult.message || transcriptResult.error);
    return;
  }

  updateLoading("Detecting spots", "Finding restaurants, cafés, and attractions…");

  const spotsResult = await chrome.runtime.sendMessage({
    action: "extractSpots",
    transcriptText: transcriptResult.transcriptTextTimestamped,
    videoTitle: currentVideoTitle,
    channelName: currentChannelName,
    videoDescription: currentVideoDescription,
  });

  if (!spotsResult.success) {
    showError(
      "Detection failed",
      spotsResult.message || spotsResult.error || "Could not extract spots from this video.",
    );
    return;
  }

  currentSpots  = spotsResult.spots  || [];
  currentRoute  = spotsResult.route  || [];
  currentHotels = spotsResult.hotels || [];

  renderSpots();
  renderRoute();
  showState("results");
  loadNotes(videoId);

  // Cache: keep transcript data too (background uses it for note-saving)
  await saveToCache(videoId, transcriptResult);
}

function updateVideoHeader() {
  if (currentVideoTitle || currentChannelName) {
    document.getElementById("videoTitle").textContent  = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    document.getElementById("videoInfo").style.display = "block";
  }
}

// ============================================================
// RENDERING — SPOTS
// ============================================================

const CATEGORY_META = {
  restaurant:   { emoji: "🍽️", label: "Restaurant" },
  cafe:         { emoji: "☕",  label: "Café" },
  bar:          { emoji: "🍸",  label: "Bar" },
  bakery:       { emoji: "🥐",  label: "Bakery" },
  market:       { emoji: "🛒",  label: "Market" },
  attraction:   { emoji: "🗺️", label: "Attraction" },
  museum:       { emoji: "🏛️", label: "Museum" },
  landmark:     { emoji: "📍",  label: "Landmark" },
  park:         { emoji: "🌳",  label: "Park" },
  neighborhood: { emoji: "🏘️", label: "Neighborhood" },
  hotel:        { emoji: "🏨",  label: "Hotel" },
  other:        { emoji: "📌",  label: "Place" },
};

function categoryMeta(cat) {
  return CATEGORY_META[cat] || CATEGORY_META.other;
}

function formatTimestamp(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function mapsUrl(spot) {
  // Prefer local script name for non-Latin destinations (gives better Maps results)
  const query = (spot.local_name || spot.name || "").trim();
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function createSpotCard(spot, notedMap = {}) {
  const meta = categoryMeta(spot.category);
  const hasLocal = spot.local_name && spot.local_name !== spot.name;
  const hasTimestamp = spot.timestamp_seconds > 0;

  const card = document.createElement("div");
  card.className = "spot-card";

  const isNoted  = notedMap && spot.name in notedMap;
  const noteId   = isNoted ? notedMap[spot.name] : null;

  card.innerHTML = `
    <div class="spot-card-top">
      <span class="spot-badge">${meta.emoji} ${escapeHtml(meta.label)}</span>
      ${hasTimestamp
        ? `<button class="spot-timestamp" data-seconds="${Number(spot.timestamp_seconds)}">${escapeHtml(formatTimestamp(spot.timestamp_seconds))}</button>`
        : ""}
    </div>
    <div class="spot-name">${escapeHtml(spot.name)}</div>
    ${hasLocal ? `<div class="spot-local-name">${escapeHtml(spot.local_name)}</div>` : ""}
    ${spot.note ? `<div class="spot-note">${escapeHtml(spot.note)}</div>` : ""}
    <div class="spot-actions">
      <a class="spot-maps-btn" href="${mapsUrl(spot)}" target="_blank" rel="noopener">
        Open in Maps
      </a>
      <button class="spot-note-btn${isNoted ? " noted" : ""}" title="${isNoted ? "Remove from collection" : "Add to collection"}"
        data-note-id="${isNoted ? escapeHtml(noteId) : ""}">
        ${isNoted ? "✓ Marked" : "📍 Mark"}
      </button>
    </div>
  `;

  // Seek to timestamp
  card.querySelector(".spot-timestamp")?.addEventListener("click", (e) => {
    e.stopPropagation();
    seekTo(Number(e.currentTarget.dataset.seconds));
  });

  // Toggle note: save if not noted, delete if already noted
  card.querySelector(".spot-note-btn")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    const alreadyNoted = btn.classList.contains("noted");

    btn.disabled = true;

    if (alreadyNoted) {
      // Delete the note
      btn.textContent = "Removing…";
      try {
        await chrome.runtime.sendMessage({ action: "deleteNote", noteId: btn.dataset.noteId });
        btn.classList.remove("noted");
        btn.textContent = "📍 Mark";
        btn.title = "Add to collection";
        btn.dataset.noteId = "";
        loadNotes(currentVideoId);
      } catch { btn.textContent = "Error"; setTimeout(() => { btn.textContent = "✓ Marked"; }, 1500); }
    } else {
      // Save the note
      btn.textContent = "Saving…";
      try {
        const result = await chrome.runtime.sendMessage({
          action: "saveNote",
          videoId: currentVideoId,
          timestamp: spot.timestamp_seconds || 0,
          videoTitle: currentVideoTitle,
          channelName: currentChannelName,
          spotName: spot.name,
        });
        if (result.success) {
          btn.classList.add("noted");
          btn.textContent = "✓ Marked";
          btn.title = "Remove from collection";
          btn.dataset.noteId = result.note.id;
          loadNotes(currentVideoId);
        } else {
          btn.textContent = "Error";
          setTimeout(() => { btn.textContent = "📍 Mark"; }, 1500);
        }
      } catch { btn.textContent = "Error"; setTimeout(() => { btn.textContent = "📍 Mark"; }, 1500); }
    }

    btn.disabled = false;
  });

  return card;
}

async function renderSpots() {
  const spotsList  = document.getElementById("spotsList");
  const hotelsList = document.getElementById("hotelsList");
  const hotelsSection = document.getElementById("hotelsSection");
  const exportBtn  = document.getElementById("exportSpotsBtn");
  const placesTitle = document.getElementById("placesTitle");
  if (!spotsList) return;

  spotsList.innerHTML = "";

  // Build a map of spotName → noteId for spots already noted on this video
  const notedMap = await buildNotedMap(currentVideoId);

  const spots = currentSpots || [];

  if (spots.length === 0) {
    spotsList.innerHTML = `
      <div class="spots-empty">
        <div class="spots-empty-icon">🔍</div>
        <div class="spots-empty-text">No named places detected in this video. The video may not have captions, or it may not be a travel video.</div>
      </div>`;
    if (exportBtn) exportBtn.style.display = "none";
    placesTitle.textContent = "Places";
  } else {
    placesTitle.textContent = `Places (${spots.length})`;
    spots.forEach((spot) => spotsList.appendChild(createSpotCard(spot, notedMap)));
    if (exportBtn) exportBtn.style.display = "";
  }

  // Hotels section
  const hotels = currentHotels || [];
  if (hotels.length > 0) {
    hotelsList.innerHTML = "";
    hotels.forEach((h) => hotelsList.appendChild(createSpotCard({ ...h, category: "hotel" }, notedMap)));
    hotelsSection.style.display = "";
  } else {
    hotelsSection.style.display = "none";
  }
}

async function buildNotedMap(videoId) {
  try {
    const result = await chrome.runtime.sendMessage({ action: "getNotes", videoId });
    const map = {};
    if (result.success) {
      for (const note of result.notes) {
        if (note.spotName) map[note.spotName] = note.id;
      }
    }
    return map;
  } catch { return {}; }
}

// ============================================================
// RENDERING — ROUTE
// ============================================================

function renderRoute() {
  const routeContent = document.getElementById("routeContent");
  if (!routeContent) return;

  const route = currentRoute || [];

  if (route.length === 0) {
    routeContent.innerHTML = `<p class="spots-empty-text">No suggested route detected in this video. The vlogger didn't follow or recommend a specific visiting order.</p>`;
    return;
  }

  routeContent.innerHTML = "";
  route.forEach((step) => {
    const hasLocal = step.local_name && step.local_name !== step.name;
    const div = document.createElement("div");
    div.className = "route-step";
    div.innerHTML = `
      <div class="route-step-number">${escapeHtml(String(step.order))}</div>
      <div class="route-step-info">
        <div class="route-step-name">${escapeHtml(step.name)}</div>
        ${hasLocal ? `<div class="route-step-local">${escapeHtml(step.local_name)}</div>` : ""}
      </div>
      <a class="spot-maps-btn route-maps-btn" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(step.local_name || step.name)}" target="_blank" rel="noopener">Maps</a>
    `;
    routeContent.appendChild(div);
  });
}

// ============================================================
// EXPORT
// ============================================================

function exportSpotsList() {
  const spots  = currentSpots  || [];
  const hotels = currentHotels || [];
  const route  = currentRoute  || [];

  let text = `TRAVEL SPOTS — ${currentVideoTitle || "Untitled"}\n`;
  text += `Channel: ${currentChannelName || "Unknown"}\n`;
  text += `Video: https://youtube.com/watch?v=${currentVideoId}\n\n`;

  if (spots.length) {
    text += "PLACES\n" + "─".repeat(40) + "\n";
    spots.forEach((s, i) => {
      text += `${i + 1}. ${s.name}`;
      if (s.local_name && s.local_name !== s.name) text += ` / ${s.local_name}`;
      text += `  [${categoryMeta(s.category).label}]`;
      if (s.timestamp_seconds > 0) text += `  @ ${formatTimestamp(s.timestamp_seconds)}`;
      text += "\n";
      if (s.note) text += `   ${s.note}\n`;
    });
    text += "\n";
  }

  if (hotels.length) {
    text += "HOTELS\n" + "─".repeat(40) + "\n";
    hotels.forEach((h, i) => {
      text += `${i + 1}. ${h.name}`;
      if (h.local_name && h.local_name !== h.name) text += ` / ${h.local_name}`;
      text += "\n";
      if (h.note) text += `   ${h.note}\n`;
    });
    text += "\n";
  }

  if (route.length) {
    text += "SUGGESTED ROUTE\n" + "─".repeat(40) + "\n";
    route.forEach((r) => {
      text += `${r.order}. ${r.name}`;
      if (r.local_name && r.local_name !== r.name) text += ` / ${r.local_name}`;
      text += "\n";
    });
    text += "\n";
  }

  text += "─".repeat(40) + "\nExported by Travel Spots Collector\n";

  const filename = `spots-${sanitizeFilename(currentVideoTitle)}.txt`;
  downloadTextFile(text, filename);
}

// ============================================================
// UI STATE
// ============================================================

function showState(state) {
  document.getElementById("welcomeState").style.display  = state === "welcome"  ? "flex"  : "none";
  document.getElementById("loadingState").style.display  = state === "loading"  ? "block" : "none";
  document.getElementById("errorState").style.display    = state === "error"    ? "block" : "none";
  document.getElementById("resultsState").style.display  = state === "results"  ? "block" : "none";
  document.getElementById("tabsNav").style.display       = state === "results"  ? "flex"  : "none";
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent    = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function showError(title, message) {
  errorAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent   = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent     = "Try Again";
}

function showConfigError(configStatus) {
  const missing = [];
  if (!configStatus.hasSupadataKey) missing.push("Supadata");
  if (!configStatus.hasAiKey)       missing.push("AI provider");
  showState("error");
  document.getElementById("errorTitle").textContent = "API Keys Missing";
  document.getElementById("errorMessage").textContent =
    `Add your ${missing.join(" and ")} API key${missing.length === 1 ? "" : "s"} in Settings.`;
  document.getElementById("errorBtn").textContent = "Open Settings";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

// ============================================================
// SEEK
// ============================================================

async function seekTo(seconds) {
  const payload = { action: "seekTo", seconds: Number(seconds) };
  try {
    if (youtubeTabId) {
      try { await chrome.tabs.sendMessage(youtubeTabId, payload); return; } catch (_) {}
    }
    await chrome.runtime.sendMessage({ action: "relayToContent", payload });
  } catch (error) {
    console.error("seekTo error:", error);
  }
}

// ============================================================
// NOTES
// ============================================================

async function loadNotes(videoId) {
  try {
    const result = await chrome.runtime.sendMessage({ action: "getNotes", videoId });
    if (result.success) renderNotes(result.notes, videoId);
  } catch (error) {
    console.error("Load notes error:", error);
  }
}

function renderNotes(notes, filteredVideoId) {
  const notesList  = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");
  if (!notesList) return;

  notesList.innerHTML = "";

  if (!notes || notes.length === 0) {
    notesIntro.style.display = "block";
    notesIntro.innerHTML = filteredVideoId
      ? "No marked spots for this video yet. Click <strong>📍 Mark</strong> on any spot to add it to your collection."
      : "No marked spots yet. Click <strong>📍 Mark</strong> on any spot to add it to your collection.";
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note) => {
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="note-timestamp" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
        <button class="note-delete" data-id="${escapeHtml(note.id)}" title="Delete note">✕</button>
      </div>
      <div class="note-text">"${escapeHtml(note.text)}"</div>
      <div class="note-actions">
        <button class="note-action-btn note-copy-text">⧉ Copy text</button>
        <button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl)}">🔗 Copy link</button>
        <button class="note-action-btn note-play" data-seconds="${Number(note.timestampSeconds) || 0}">▶ Play</button>
      </div>
    `;

    noteEl.querySelector(".note-timestamp").addEventListener("click", () => playNote(note));

    noteEl.querySelector(".note-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteNote(note.id);
      loadNotes(filteredVideoId);
    });

    noteEl.querySelector(".note-copy-text").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(note.text);
        const btn = noteEl.querySelector(".note-copy-text");
        btn.textContent = "✓ Copied!";
        setTimeout(() => { btn.textContent = "⧉ Copy text"; }, 2000);
      } catch {}
    });

    noteEl.querySelector(".note-copy-link").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(note.timestampedUrl);
        const btn = noteEl.querySelector(".note-copy-link");
        btn.textContent = "✓ Copied!";
        setTimeout(() => { btn.textContent = "🔗 Copy link"; }, 2000);
      } catch {}
    });

    noteEl.querySelector(".note-play").addEventListener("click", () => playNote(note));

    notesList.appendChild(noteEl);
  });
}

function playNote(note) {
  if (note.videoId && note.videoId === currentVideoId) {
    seekTo(note.timestampSeconds);
  } else {
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({ action: "deleteNote", noteId });
  } catch (error) {
    console.error("Delete note error:", error);
  }
}

// ============================================================
// CACHE
// ============================================================

async function saveToCache(videoId, transcriptResult) {
  if (!videoId) return;
  try {
    const cacheData = {
      spots:           currentSpots,
      route:           currentRoute,
      hotels:          currentHotels,
      // Keep raw transcript so background.js can use it for note-saving
      transcript:      transcriptResult?.transcript             || [],
      transcriptText:  transcriptResult?.transcriptText         || "",
      videoTitle:      currentVideoTitle,
      channelName:     currentChannelName,
      timestamp:       Date.now(),
    };
    await chrome.storage.local.set({ [`digest_${videoId}`]: cacheData });
    await evictOldCacheEntries(20);
  } catch (error) {
    console.error("Cache save error:", error);
  }
}

async function loadFromCache(videoId) {
  if (!videoId) return null;
  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    const cached = result[`digest_${videoId}`];
    if (!cached) return null;
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
      return null;
    }
    // Only treat as valid if it has spots data (not a legacy transcript-only entry)
    if (!Array.isArray(cached.spots)) return null;
    return cached;
  } catch { return null; }
}

async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let digestKeys = Object.keys(allData).filter((k) => k.startsWith("digest_"));
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = digestKeys.filter((key) => {
      const ts = Number(allData[key]?.timestamp) || 0;
      return Date.now() - ts > THIRTY_DAYS;
    });
    if (expired.length) {
      await chrome.storage.local.remove(expired);
      const expiredSet = new Set(expired);
      digestKeys = digestKeys.filter((k) => !expiredSet.has(k));
    }
    if (digestKeys.length <= maxEntries) return;
    const sorted = digestKeys
      .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);
    const toRemove = sorted.slice(0, sorted.length - maxEntries).map((e) => e.key);
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}
