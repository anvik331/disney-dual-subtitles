(function installDisneyBridge() {
  "use strict";

  if (window.__DDS_BRIDGE_INSTALLED__) return;
  Object.defineProperty(window, "__DDS_BRIDGE_INSTALLED__", { value: true });

  const SOURCE = "disney-dual-subtitles-bridge";
  const CONTENT_SOURCE = "disney-dual-subtitles-content";
  const MAX_TEXT_LENGTH = 2_500_000;
  const observedUrls = new Set();
  const manifestSnapshots = new Map();
  const nativeFetch = window.fetch.bind(window);
  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const nativeXhrSend = XMLHttpRequest.prototype.send;
  const xhrUrls = new WeakMap();
  let timelineSequence = 0;
  let lastTimelineSignature = "";
  let contentConnected = false;

  function routeKey() {
    return `${location.pathname}${location.search}`;
  }

  function post(type, payload = {}) {
    window.postMessage(
      { source: SOURCE, version: 1, type, routeKey: routeKey(), ...payload },
      location.origin,
    );
  }

  function resolveUrl(value) {
    try {
      return new URL(String(value), location.href).href;
    } catch {
      return null;
    }
  }

  function isDisneyMediaUrl(value) {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        (url.hostname === "media.dssott.com" ||
          url.hostname.endsWith(".media.dssott.com"))
      );
    } catch {
      return false;
    }
  }

  function looksLikeManifestUrl(value) {
    return isDisneyMediaUrl(value) && new URL(value).pathname.endsWith(".m3u8");
  }

  function looksLikeSubtitleSegmentUrl(value) {
    if (!isDisneyMediaUrl(value)) return false;
    return /\.(?:vtt|webvtt)$/i.test(new URL(value).pathname);
  }

  function looksLikeSubtitleMediaPlaylist(raw) {
    return /(?:^|\n)[^#\n][^\n]*\.(?:vtt|webvtt)(?:\?[^\n]*)?(?:\n|$)/i.test(raw);
  }

  function announceUrl(url) {
    if (!looksLikeManifestUrl(url) || observedUrls.has(url)) return;
    observedUrls.add(url);
    post("manifest-url", { url });
  }

  function replayObservedResources() {
    for (const [url, raw] of manifestSnapshots) {
      post("manifest", { url, raw });
    }
    for (const url of observedUrls) {
      if (!manifestSnapshots.has(url)) post("manifest-url", { url });
    }
  }

  function announceBridgeReady() {
    post("bridge-ready");
  }

  function findManifestUrls(value) {
    const queue = [{ value, depth: 0 }];
    const seen = new WeakSet();
    let visited = 0;
    while (queue.length && visited < 20_000) {
      const current = queue.shift();
      visited += 1;
      if (typeof current.value === "string") {
        if (looksLikeManifestUrl(current.value)) announceUrl(current.value);
        continue;
      }
      if (!current.value || typeof current.value !== "object" || current.depth >= 9) {
        continue;
      }
      if (seen.has(current.value)) continue;
      seen.add(current.value);
      for (const nested of Object.values(current.value)) {
        queue.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }

  function inspectText(url, text) {
    if (!text || text.length > MAX_TEXT_LENGTH) return;
    const normalized = text.replace(/^\uFEFF/, "");
    if (normalized.startsWith("WEBVTT") && looksLikeSubtitleSegmentUrl(url)) {
      post("subtitle-segment", { url, raw: normalized });
      return;
    }
    if (
      normalized.startsWith("#EXTM3U") &&
      normalized.includes("#EXT-X-MEDIA:TYPE=SUBTITLES") &&
      isDisneyMediaUrl(url)
    ) {
      manifestSnapshots.set(url, normalized);
      post("manifest", { url, raw: normalized });
      return;
    }
    if (
      normalized.startsWith("#EXTM3U") &&
      looksLikeManifestUrl(url) &&
      looksLikeSubtitleMediaPlaylist(normalized)
    ) {
      post("media-playlist", { url, raw: normalized });
      return;
    }
    const first = normalized.trimStart()[0];
    if (first !== "{" && first !== "[") return;
    try {
      findManifestUrls(JSON.parse(normalized));
    } catch {
      // A playback response can be truncated or non-JSON; observation stays passive.
    }
  }

  async function inspectFetchResponse(response, requestedUrl) {
    try {
      const responseUrl = resolveUrl(response.url) || requestedUrl;
      if (!response.ok || !responseUrl) return;
      const contentType = response.headers.get("content-type") || "";
      const interesting =
        looksLikeManifestUrl(responseUrl) ||
        looksLikeSubtitleSegmentUrl(responseUrl) ||
        contentType.includes("json") ||
        contentType.includes("text/vtt") ||
        contentType.includes("mpegurl") ||
        contentType.includes("application/vnd.apple");
      if (!interesting) return;
      if (looksLikeManifestUrl(responseUrl)) announceUrl(responseUrl);
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_TEXT_LENGTH) return;
      inspectText(responseUrl, await response.clone().text());
    } catch {
      // Never change playback when inspection fails.
    }
  }

  window.fetch = function disneyDualSubtitlesFetch(input, init) {
    const requestedUrl = resolveUrl(input instanceof Request ? input.url : input);
    const response = nativeFetch(input, init);
    void response.then(
      (result) => inspectFetchResponse(result, requestedUrl),
      () => undefined,
    );
    return response;
  };

  XMLHttpRequest.prototype.open = function disneyDualSubtitlesOpen(
    method,
    url,
    async,
    username,
    password,
  ) {
    const resolved = resolveUrl(url);
    if (resolved) xhrUrls.set(this, resolved);
    return nativeXhrOpen.call(this, method, url, async ?? true, username, password);
  };

  XMLHttpRequest.prototype.send = function disneyDualSubtitlesSend(body) {
    const requestedUrl = xhrUrls.get(this);
    this.addEventListener(
      "load",
      () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          const responseUrl = resolveUrl(this.responseURL) || requestedUrl;
          if (!responseUrl) return;
          if (looksLikeManifestUrl(responseUrl)) announceUrl(responseUrl);
          if (
            looksLikeSubtitleSegmentUrl(responseUrl) &&
            this.responseType !== "" &&
            this.responseType !== "text"
          ) {
            post("subtitle-segment-url", { url: responseUrl });
          }
          if (this.responseType === "json") findManifestUrls(this.response);
          else if (this.responseType === "" || this.responseType === "text") {
            inspectText(responseUrl, this.responseText);
          }
        } catch {
          // Some XHR response types throw on responseText access.
        }
      },
      { once: true },
    );
    return nativeXhrSend.call(this, body);
  };

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.source !== CONTENT_SOURCE ||
      event.data?.version !== 1 ||
      event.data?.routeKey !== routeKey()
    ) {
      return;
    }
    if (event.data.type === "ready") {
      contentConnected = true;
      replayObservedResources();
      scanPerformanceEntries();
    } else if (event.data.type === "timeline-request") {
      publishTimeline(true);
    }
  });

  function readTimeline() {
    try {
      const modern = document.querySelector("disney-web-player-ui");
      const legacy = document.querySelector("disney-web-player");
      const api = modern?.mediaPlayerApi || legacy?.mediaPlayer || legacy?.mediaPlayerApi;
      const timeMs = api?.timeline?.info?.playheadPositionMs;
      if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > 86_400_000) return null;

      const overlay = document.querySelector("main-app-controls-overlay");
      const interstitial = overlay?.store?.interstitials?.isInterstitialPlaying;
      return {
        timeMs,
        interstitial: typeof interstitial === "boolean" ? interstitial : false,
      };
    } catch {
      return null;
    }
  }

  function publishTimeline(force = false) {
    const timeline = readTimeline();
    if (!timeline) return;
    const signature = `${routeKey()}|${Math.floor(timeline.timeMs / 250)}|${timeline.interstitial}`;
    if (!force && signature === lastTimelineSignature) return;
    lastTimelineSignature = signature;
    timelineSequence += 1;
    post("timeline", { ...timeline, sequence: timelineSequence });
  }

  function scanPerformanceEntries() {
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        if (looksLikeManifestUrl(entry.name)) announceUrl(entry.name);
      }
    } catch {
      // Performance entries are only a fallback discovery path.
    }
  }

  window.setInterval(publishTimeline, 250);
  window.setInterval(scanPerformanceEntries, 2000);
  window.setInterval(() => {
    if (!contentConnected) announceBridgeReady();
  }, 1000);
  announceBridgeReady();
  publishTimeline();
  scanPerformanceEntries();
})();
