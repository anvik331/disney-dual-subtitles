(function startDisneyDualSubtitles() {
  "use strict";

  const core = globalThis.DDSCore;
  if (!core || globalThis.__DDS_CONTENT_INSTALLED__) return;
  Object.defineProperty(globalThis, "__DDS_CONTENT_INSTALLED__", { value: true });

  const BRIDGE_SOURCE = "disney-dual-subtitles-bridge";
  const CONTENT_SOURCE = "disney-dual-subtitles-content";
  const STORAGE_KEY = "dds.settings.v1";
  const EXTERNAL_TRACK_ID = "external:uploaded";
  const FETCH_CONCURRENCY = 6;
  const MAX_SEGMENTS = 2000;
  const PLAYLIST_REFRESH_MS = 15_000;
  const NATIVE_SELECTORS = [
    "timed-text-override-region",
    ".timed-text-override-region",
    "#timed-text-override-region",
    ".TimedTextOverlay",
    ".hive-subtitle-renderer-wrapper",
    ".hive-subtitle-renderer-cue-positioning-box",
    ".hive-subtitle-renderer-cue-window",
  ].join(",");

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    hideNative: true,
    timeOffset: 0,
    topFontSize: 28,
    bottomFontSize: 28,
    position: 9,
    backgroundOpacity: 0.72,
    topColor: "#ffffff",
    bottomColor: "#66d9ff",
    topPreference: null,
    bottomPreference: null,
  });

  let settings = { ...DEFAULT_SETTINGS };
  let routeKey = currentRouteKey();
  let selectedTopId = null;
  let selectedBottomId = null;
  let externalTrack = null;
  let loadGeneration = 0;
  let manifestGeneration = 0;
  let timeline = null;
  let overlay = null;
  let renderTimer = null;
  let videoFrameVideo = null;
  let videoFrameHandle = null;
  let routeTimer = null;
  let nativeTimer = null;
  let playlistTimer = null;
  let nativeHidden = false;
  let seekRevision = 0;
  let awaitingSeekTimeline = false;
  let backgroundRefreshInFlight = false;

  const attemptedManifestUrls = new Set();
  const cueCache = new Map();
  const cuePromises = new Map();
  const segmentCueCache = new Map();
  const playlistSignatures = new Map();
  const segmentOwners = new Map();
  const segmentBaseOwners = new Map();
  const segmentFetchPromises = new Map();
  const loadProgress = new Map();
  const nativeElements = new Map();
  const styledRoots = new Set();
  const watchedVideos = new WeakSet();
  const seekTimers = new Set();

  const state = {
    tracks: [],
    topCues: [],
    bottomCues: [],
    status: "等待 Disney+ 播放器提供字幕資料…",
    loading: false,
    error: null,
  };

  function currentRouteKey() {
    return `${location.pathname}${location.search}`;
  }

  function requestBridgeReplay() {
    window.postMessage(
      {
        source: CONTENT_SOURCE,
        version: 1,
        type: "ready",
        routeKey,
      },
      location.origin,
    );
  }

  function requestTimeline() {
    window.postMessage(
      {
        source: CONTENT_SOURCE,
        version: 1,
        type: "timeline-request",
        routeKey,
      },
      location.origin,
    );
  }

  function clamp(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(maximum, Math.max(minimum, number))
      : fallback;
  }

  function validColor(value, fallback) {
    return typeof value === "string" && /^#[\da-f]{6}$/i.test(value)
      ? value
      : fallback;
  }

  function sanitizePreference(value) {
    if (!value || typeof value !== "object") return null;
    const language = typeof value.language === "string" ? value.language : "";
    const label = typeof value.label === "string" ? value.label : "";
    const kind = typeof value.kind === "string" ? value.kind : "subtitle";
    return language && label ? { language, label, kind } : null;
  }

  function sanitizeSettings(value) {
    const input = value && typeof value === "object" ? value : {};
    const legacyFontSize = clamp(input.fontSize, 14, 52, 28);
    return {
      enabled: typeof input.enabled === "boolean" ? input.enabled : true,
      hideNative: typeof input.hideNative === "boolean" ? input.hideNative : true,
      timeOffset: clamp(input.timeOffset, -120, 120, 0),
      topFontSize: clamp(input.topFontSize, 14, 52, legacyFontSize),
      bottomFontSize: clamp(input.bottomFontSize, 14, 52, legacyFontSize),
      position: clamp(input.position, 3, 42, 9),
      backgroundOpacity: clamp(input.backgroundOpacity, 0, 1, 0.72),
      topColor: validColor(input.topColor, "#ffffff"),
      bottomColor: validColor(input.bottomColor, "#66d9ff"),
      topPreference: sanitizePreference(input.topPreference),
      bottomPreference: sanitizePreference(input.bottomPreference),
    };
  }

  async function persistSettings() {
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
  }

  function trackPreference(track) {
    return track
      ? { language: track.language, label: track.label, kind: track.kind }
      : null;
  }

  function preferenceMatches(track, preference) {
    return Boolean(
      preference &&
        track.language === preference.language &&
        track.label === preference.label &&
        track.kind === preference.kind,
    );
  }

  function languageMatches(track, candidates) {
    const language = track.language.toLowerCase();
    const label = track.label.toLowerCase();
    return candidates.some((candidate) => {
      const key = candidate.toLowerCase();
      return language === key || language.startsWith(`${key}-`) || label.includes(key);
    });
  }

  function chooseTrack(preference, languages, excludedId = null) {
    const candidates = state.tracks.filter(
      (track) => track.id !== excludedId && !track.forced,
    );
    return (
      candidates.find((track) => preferenceMatches(track, preference)) ||
      candidates.find((track) => languageMatches(track, languages)) ||
      candidates[0] ||
      state.tracks.find((track) => track.id !== excludedId) ||
      null
    );
  }

  function applyAutomaticSelection() {
    const top = chooseTrack(settings.topPreference, ["en", "english"]);
    let bottom = chooseTrack(
      settings.bottomPreference,
      ["zh-hant", "zh-tw", "繁體", "繁中", "chinese"],
      top?.id || null,
    );
    if (!bottom && top) bottom = top;
    selectedTopId = top?.id || null;
    selectedBottomId = externalTrack ? EXTERNAL_TRACK_ID : bottom?.id || null;
  }

  function fetchText(url, options = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "DDS_FETCH_TEXT",
          url,
          forceRefresh: Boolean(options.forceRefresh),
        },
        (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || "字幕請求失敗"));
            return;
          }
          resolve(response);
        },
      );
    });
  }

  function progressStatus() {
    const entries = [...loadProgress.values()];
    const completed = entries.reduce((sum, item) => sum + item.completed, 0);
    const total = entries.reduce((sum, item) => sum + item.total, 0);
    return total ? `正在載入官方字幕 ${completed}/${total}…` : "正在讀取字幕清單…";
  }

  function updateProgress(trackId, completed, total) {
    loadProgress.set(trackId, { completed, total });
    state.status = progressStatus();
  }

  function rememberTrackSegments(track, segments) {
    const firstPts = segments.find((segment) => segment.pts !== null)?.pts ?? null;
    const firstPresentationTimeMs = firstPts === null ? null : firstPts / 90;
    for (const segment of segments) {
      let owners = segmentOwners.get(segment.url);
      if (!owners) {
        owners = new Map();
        segmentOwners.set(segment.url, owners);
      }
      owners.set(track.playlistUrl, {
        language: track.language,
        fallbackOffsetMs: segment.elapsedMs,
        anchor:
          segment.pts !== null && firstPresentationTimeMs !== null
            ? {
                mpegTs: segment.pts % core.MPEG_TS_WRAP,
                presentationTimeMs: firstPresentationTimeMs + segment.elapsedMs,
              }
            : null,
      });
      try {
        const baseUrl = new URL(".", segment.url).href;
        let baseOwners = segmentBaseOwners.get(baseUrl);
        if (!baseOwners) {
          baseOwners = new Set();
          segmentBaseOwners.set(baseUrl, baseOwners);
        }
        baseOwners.add(track.playlistUrl);
      } catch {
        // Segment URLs have already been validated; this is only a matching fallback.
      }
    }
    return { firstPts, firstPresentationTimeMs };
  }

  async function loadOfficialTrack(track, generation, options = {}) {
    const cacheKey = track.playlistUrl;
    const forceRefresh = Boolean(options.forceRefresh);
    const reportProgress = options.reportProgress !== false;
    if (!forceRefresh && cueCache.has(cacheKey)) return cueCache.get(cacheKey);
    if (!forceRefresh && cuePromises.has(cacheKey)) return cuePromises.get(cacheKey);

    const promise = (async () => {
      if (reportProgress) updateProgress(track.id, 0, 0);
      const playlistResponse = await fetchText(track.playlistUrl, { forceRefresh });
      if (generation !== loadGeneration) throw new Error("字幕選擇已變更");
      const playlistRaw = playlistResponse.text.replace(/^\uFEFF/, "");
      if (playlistRaw.startsWith("WEBVTT")) {
        const signature = `direct:${playlistRaw}`;
        if (
          forceRefresh &&
          playlistSignatures.get(cacheKey) === signature &&
          cueCache.has(cacheKey)
        ) {
          return cueCache.get(cacheKey);
        }
        const directCues = core.normalizeCues(
          core.parseWebVtt(playlistRaw, { language: track.language }),
        );
        if (!directCues.length) throw new Error(`${track.label} 字幕內容為空`);
        playlistSignatures.set(cacheKey, signature);
        cueCache.set(cacheKey, directCues);
        return directCues;
      }

      const segments = core.parseMediaPlaylist(playlistRaw, playlistResponse.url);
      if (!segments.length || segments.length > MAX_SEGMENTS) {
        throw new Error(`${track.label} 的字幕分段清單無效`);
      }
      const { firstPresentationTimeMs } = rememberTrackSegments(track, segments);
      const signature = segments
        .map((segment) => `${segment.url}\u0000${segment.durationMs}\u0000${segment.pts ?? ""}`)
        .join("\n");
      if (
        forceRefresh &&
        playlistSignatures.get(cacheKey) === signature &&
        cueCache.has(cacheKey)
      ) {
        return cueCache.get(cacheKey);
      }
      if (reportProgress) updateProgress(track.id, 0, segments.length);

      const parsed = Array.from({ length: segments.length }, () => []);
      let nextIndex = 0;
      let completed = 0;

      async function worker() {
        while (nextIndex < segments.length) {
          const index = nextIndex;
          nextIndex += 1;
          const segment = segments[index];
          if (segmentCueCache.has(segment.url)) {
            parsed[index] = segmentCueCache.get(segment.url);
            completed += 1;
            if (
              reportProgress &&
              (completed === segments.length || completed % 5 === 0)
            ) {
              updateProgress(track.id, completed, segments.length);
            }
            continue;
          }
          const response = await fetchText(segment.url);
          if (generation !== loadGeneration) throw new Error("字幕選擇已變更");
          const anchor =
            segment.pts !== null && firstPresentationTimeMs !== null
              ? {
                  mpegTs: segment.pts % core.MPEG_TS_WRAP,
                  presentationTimeMs: firstPresentationTimeMs + segment.elapsedMs,
                }
              : null;
          const segmentCues = core.parseWebVtt(response.text, {
            language: track.language,
            anchor,
            fallbackOffsetMs: segment.elapsedMs,
          });
          parsed[index] = segmentCues;
          segmentCueCache.set(segment.url, segmentCues);
          completed += 1;
          if (
            reportProgress &&
            (completed === segments.length || completed % 5 === 0)
          ) {
            updateProgress(track.id, completed, segments.length);
          }
        }
      }

      await Promise.all(
        Array.from(
          { length: Math.min(FETCH_CONCURRENCY, segments.length) },
          () => worker(),
        ),
      );
      const cues = core.mergeCueWindows(
        forceRefresh ? cueCache.get(cacheKey) || [] : [],
        parsed.flat(),
      );
      if (!cues.length) throw new Error(`${track.label} 字幕內容為空`);
      playlistSignatures.set(cacheKey, signature);
      cueCache.set(cacheKey, cues);
      return cues;
    })();

    cuePromises.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      if (cuePromises.get(cacheKey) === promise) cuePromises.delete(cacheKey);
    }
  }

  function getTrack(id) {
    return state.tracks.find((track) => track.id === id) || null;
  }

  function startSelectedTrackLoad(options = {}) {
    const forceRefresh = Boolean(options.forceRefresh);
    const preserveExisting = Boolean(options.preserveExisting);
    const silent = Boolean(options.silent);
    const generation = ++loadGeneration;
    loadProgress.clear();
    if (!silent) {
      state.loading = true;
      state.error = null;
    }
    const previousTopCues = state.topCues;
    const previousBottomCues = state.bottomCues;
    if (!preserveExisting) {
      state.topCues = [];
      state.bottomCues =
        selectedBottomId === EXTERNAL_TRACK_ID && externalTrack ? externalTrack.cues : [];
    }

    const topTrack = getTrack(selectedTopId);
    const bottomTrack = getTrack(selectedBottomId);
    const topPromise = topTrack
      ? loadOfficialTrack(topTrack, generation, {
          forceRefresh,
          reportProgress: !silent,
        })
      : Promise.resolve([]);
    const bottomPromise = bottomTrack
      ? topTrack?.playlistUrl === bottomTrack.playlistUrl
        ? topPromise
        : loadOfficialTrack(bottomTrack, generation, {
            forceRefresh,
            reportProgress: !silent,
          })
      : Promise.resolve(state.bottomCues);

    if (!silent) state.status = progressStatus();
    return Promise.allSettled([topPromise, bottomPromise]).then((results) => {
      if (generation !== loadGeneration) return;
      const [topResult, bottomResult] = results;
      state.topCues =
        topResult.status === "fulfilled"
          ? topResult.value
          : preserveExisting
            ? previousTopCues
            : [];
      state.bottomCues =
        selectedBottomId === EXTERNAL_TRACK_ID && externalTrack
          ? externalTrack.cues
          : bottomResult.status === "fulfilled"
            ? bottomResult.value
            : preserveExisting
              ? previousBottomCues
              : [];
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason?.message || String(result.reason));
      if (silent) {
        renderFrame();
        return;
      }
      state.loading = false;
      state.error = errors.length ? errors.join("；") : null;
      if (state.topCues.length || state.bottomCues.length) {
        state.status = errors.length
          ? `字幕已載入，但有錯誤：${state.error}`
          : `雙字幕已就緒（${state.topCues.length}／${state.bottomCues.length} 段）`;
      } else {
        state.status = state.error || "沒有可顯示的字幕";
      }
      renderFrame();
    });
  }

  function acceptManifest(raw, url, messageRouteKey) {
    if (messageRouteKey !== routeKey || raw.length > 2_500_000) return false;
    const tracks = core.parseMasterManifest(raw, url);
    if (!tracks.length) return false;

    const signature = tracks.map((track) => track.playlistUrl).join("\n");
    const currentSignature = state.tracks.map((track) => track.playlistUrl).join("\n");
    if (signature === currentSignature) return true;

    manifestGeneration += 1;
    state.tracks = tracks;
    cueCache.clear();
    cuePromises.clear();
    segmentCueCache.clear();
    playlistSignatures.clear();
    segmentOwners.clear();
    segmentBaseOwners.clear();
    segmentFetchPromises.clear();
    applyAutomaticSelection();
    state.status = `已找到 ${tracks.length} 組 Disney+ 官方字幕`;
    startSelectedTrackLoad();
    return true;
  }

  async function inspectManifestUrl(url, messageRouteKey) {
    if (
      messageRouteKey !== routeKey ||
      attemptedManifestUrls.has(url) ||
      !core.isAllowedMediaUrl(url)
    ) {
      return;
    }
    attemptedManifestUrls.add(url);
    const generation = manifestGeneration;
    try {
      const response = await fetchText(url);
      if (messageRouteKey !== routeKey || generation !== manifestGeneration) return;
      acceptManifest(response.text, response.url, messageRouteKey);
    } catch {
      // Many observed .m3u8 files are video/audio variants; failures stay silent.
    }
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.source !== BRIDGE_SOURCE ||
      event.data?.version !== 1 ||
      typeof event.data.routeKey !== "string"
    ) {
      return;
    }

    const message = event.data;
    if (message.type === "bridge-ready" && message.routeKey === routeKey) {
      requestBridgeReplay();
    } else if (
      message.type === "manifest" &&
      typeof message.url === "string" &&
      typeof message.raw === "string" &&
      core.isAllowedMediaUrl(message.url)
    ) {
      acceptManifest(message.raw, message.url, message.routeKey);
    } else if (
      message.type === "manifest-url" &&
      typeof message.url === "string"
    ) {
      void inspectManifestUrl(message.url, message.routeKey);
    } else if (
      message.type === "media-playlist" &&
      message.routeKey === routeKey &&
      typeof message.url === "string" &&
      typeof message.raw === "string" &&
      core.isAllowedMediaUrl(message.url)
    ) {
      acceptObservedMediaPlaylist(message.raw, message.url);
    } else if (
      message.type === "subtitle-segment" &&
      message.routeKey === routeKey &&
      typeof message.url === "string" &&
      typeof message.raw === "string" &&
      core.isAllowedMediaUrl(message.url)
    ) {
      acceptObservedSubtitleSegment(message.raw, message.url);
    } else if (
      message.type === "subtitle-segment-url" &&
      message.routeKey === routeKey &&
      typeof message.url === "string" &&
      core.isAllowedMediaUrl(message.url)
    ) {
      void fetchObservedSubtitleSegment(message.url);
    } else if (
      message.type === "timeline" &&
      message.routeKey === routeKey &&
      Number.isFinite(message.timeMs) &&
      message.timeMs >= 0
    ) {
      if (!timeline || message.sequence > timeline.sequence) {
        const video = findBestVideo();
        if (video?.seeking) return;
        timeline = {
          timeMs: message.timeMs,
          interstitial: Boolean(message.interstitial),
          sequence: message.sequence,
          receivedAt: performance.now(),
          video,
          videoTimeMs: Number.isFinite(video?.currentTime)
            ? video.currentTime * 1000
            : null,
        };
        awaitingSeekTimeline = false;
      }
    }
  });

  function openRoots() {
    const roots = [document];
    const selectors = [
      "disney-web-player-ui",
      "disney-web-player",
      "main-app-controls-overlay",
      "main-app-player",
      "video",
      "[class*='player']",
    ].join(",");
    for (let index = 0; index < roots.length && roots.length < 40; index += 1) {
      const root = roots[index];
      for (const element of root.querySelectorAll?.(selectors) || []) {
        if (element.shadowRoot && !roots.includes(element.shadowRoot)) {
          roots.push(element.shadowRoot);
        }
      }
    }
    return roots;
  }

  function findBestVideo() {
    const videos = openRoots().flatMap((root) => [...(root.querySelectorAll?.("video") || [])]);
    let best = null;
    let bestScore = -Infinity;
    for (const video of [...new Set(videos)]) {
      watchVideo(video);
      const rect = video.getBoundingClientRect();
      let score = rect.width > 0 && rect.height > 0 ? rect.width * rect.height : -1000;
      if (!video.paused && !video.ended) score += 1_000_000;
      if (video.readyState >= 2) score += 500_000;
      if (video.currentTime > 0) score += 100_000;
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }
    return best;
  }

  function scheduleSeekTask(callback, delay, revision) {
    const timer = window.setTimeout(() => {
      seekTimers.delete(timer);
      if (revision === seekRevision) callback();
    }, delay);
    seekTimers.add(timer);
  }

  function refreshSelectedTracks(options = {}) {
    if (state.loading || backgroundRefreshInFlight) return;
    if (!getTrack(selectedTopId) && !getTrack(selectedBottomId)) return;
    const silent = Boolean(options.silent);
    if (!silent) state.status = "正在更新跳轉位置的字幕…";
    const refresh = startSelectedTrackLoad({
      forceRefresh: true,
      preserveExisting: true,
      silent,
    });
    if (silent) {
      backgroundRefreshInFlight = true;
      void refresh.finally(() => {
        backgroundRefreshInFlight = false;
      });
    }
  }

  function tracksForObservedSegment(url) {
    const exactOwners = segmentOwners.get(url);
    if (exactOwners?.size) return exactOwners;
    for (const [baseUrl, playlistUrls] of segmentBaseOwners) {
      if (!url.startsWith(baseUrl) || playlistUrls.size !== 1) continue;
      const owners = new Map();
      for (const playlistUrl of playlistUrls) {
        const track = state.tracks.find((candidate) => candidate.playlistUrl === playlistUrl);
        if (track) {
          owners.set(playlistUrl, {
            language: track.language,
            fallbackOffsetMs: 0,
            anchor: null,
          });
        }
      }
      return owners;
    }
    return null;
  }

  function acceptObservedMediaPlaylist(raw, url) {
    if (raw.length > 2_500_000) return;
    const track = state.tracks.find((candidate) => candidate.playlistUrl === url);
    if (!track) return;
    const segments = core.parseMediaPlaylist(raw, url);
    if (segments.length && segments.length <= MAX_SEGMENTS) {
      rememberTrackSegments(track, segments);
    }
  }

  function acceptObservedSubtitleSegment(raw, url) {
    if (raw.length > 2_500_000 || !raw.replace(/^\uFEFF/, "").startsWith("WEBVTT")) {
      return;
    }
    const owners = tracksForObservedSegment(url);
    if (!owners?.size) return;
    let changed = false;
    for (const [playlistUrl, metadata] of owners) {
      const track = state.tracks.find((candidate) => candidate.playlistUrl === playlistUrl);
      if (!track) continue;
      let anchor = metadata.anchor;
      if (!anchor) {
        const pts = core.ptsFromUrl(url);
        if (pts !== null) {
          anchor = { mpegTs: pts % core.MPEG_TS_WRAP, presentationTimeMs: pts / 90 };
        }
      }
      const cues = core.parseWebVtt(raw, {
        language: track.language,
        anchor,
        fallbackOffsetMs: metadata.fallbackOffsetMs,
      });
      if (!cues.length) continue;
      const merged = core.mergeCueWindows(cueCache.get(playlistUrl) || [], cues);
      cueCache.set(playlistUrl, merged);
      segmentCueCache.set(url, cues);
      if (selectedTopId === track.id) state.topCues = merged;
      if (selectedBottomId === track.id) state.bottomCues = merged;
      changed = true;
    }
    if (changed) renderFrame();
  }

  async function fetchObservedSubtitleSegment(url) {
    if (segmentFetchPromises.has(url) || !tracksForObservedSegment(url)?.size) return;
    const promise = fetchText(url)
      .then((response) => acceptObservedSubtitleSegment(response.text, response.url))
      .catch(() => undefined);
    segmentFetchPromises.set(url, promise);
    try {
      await promise;
    } finally {
      if (segmentFetchPromises.get(url) === promise) segmentFetchPromises.delete(url);
    }
  }

  function watchVideo(video) {
    if (watchedVideos.has(video)) return;
    watchedVideos.add(video);
    video.addEventListener("seeking", () => {
      if (findBestVideo() !== video) return;
      seekRevision += 1;
      awaitingSeekTimeline = true;
      timeline = null;
      hideOverlay();
    });
    video.addEventListener("seeked", () => {
      if (findBestVideo() !== video) return;
      const revision = seekRevision;
      awaitingSeekTimeline = true;
      timeline = null;
      for (const delay of [0, 150, 500]) {
        scheduleSeekTask(requestTimeline, delay, revision);
      }
      scheduleSeekTask(() => refreshSelectedTracks(), 250, revision);
      scheduleSeekTask(() => refreshSelectedTracks({ silent: true }), 1500, revision);
      scheduleSeekTask(() => refreshSelectedTracks({ silent: true }), 3500, revision);
      scheduleSeekTask(() => {
        awaitingSeekTimeline = false;
        renderFrame(video);
      }, 1200, revision);
    });
  }

  function overlayAnchor() {
    return document.fullscreenElement || document.documentElement;
  }

  function ensureOverlay(video) {
    const anchor = overlayAnchor();
    if (!anchor) return null;
    if (!overlay) {
      const host = document.createElement("div");
      host.dataset.ddsOverlay = "";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        :host { position:fixed; z-index:2147483646; display:block;
          overflow:hidden; pointer-events:none; container-type:size;
          transform:translateZ(0); }
        .board { position:absolute; left:50%; bottom:var(--dds-position, 9%);
          transform:translateX(-50%); width:max-content; max-width:min(92%, 76rem);
          box-sizing:border-box; padding:.32em .62em .38em; border-radius:.24em;
          background:rgb(0 0 0 / var(--dds-bg, .72)); color:#fff;
          text-align:center; font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
          font-size:max(var(--dds-top-size, 28px), var(--dds-bottom-size, 28px));
          line-height:1.28;
          text-shadow:0 .06em .12em #000, 0 0 .18em #000; }
        .line { white-space:pre-line; unicode-bidi:plaintext; }
        .top { color:var(--dds-top, #fff); font-size:var(--dds-top-size, 28px);
          font-weight:650; }
        .bottom { color:var(--dds-bottom, #66d9ff);
          font-size:var(--dds-bottom-size, 28px); margin-top:.08em; }
        .line:empty { display:none; }
        .top:empty + .bottom { margin-top:0; }
      `;
      const board = document.createElement("div");
      board.className = "board";
      board.setAttribute("role", "presentation");
      const top = document.createElement("div");
      top.className = "line top";
      top.dir = "auto";
      const bottom = document.createElement("div");
      bottom.className = "line bottom";
      bottom.dir = "auto";
      board.append(top, bottom);
      shadow.append(style, board);
      overlay = { host, board, top, bottom, anchor: null };
    }

    if (overlay.anchor !== anchor || overlay.host.parentNode !== anchor) {
      anchor.append(overlay.host);
      overlay.anchor = anchor;
    }
    const rect = video.getBoundingClientRect();
    overlay.host.style.left = `${rect.left}px`;
    overlay.host.style.top = `${rect.top}px`;
    overlay.host.style.width = `${rect.width}px`;
    overlay.host.style.height = `${rect.height}px`;
    return overlay;
  }

  function hideOverlay() {
    if (overlay) overlay.host.style.display = "none";
  }

  function ensureNativeStyle(root) {
    if (styledRoots.has(root)) return;
    const style = document.createElement("style");
    style.dataset.ddsNativeStyle = "";
    style.textContent = `
      ${NATIVE_SELECTORS.split(",")
        .map((selector) => `${selector}[data-dds-native-hidden]`)
        .join(",")} { visibility:hidden !important; opacity:0 !important; }
      video[data-dds-native-hidden]::cue {
        color:transparent !important; background:transparent !important;
        text-shadow:none !important; opacity:0 !important;
      }
    `;
    if (root === document) (document.head || document.documentElement)?.append(style);
    else root.append(style);
    styledRoots.add(root);
  }

  function setNativeCaptionsHidden(hidden, force = false) {
    if (hidden === nativeHidden && !force) return;
    if (!hidden) {
      for (const [element, wasPresent] of nativeElements) {
        if (!wasPresent) element.removeAttribute("data-dds-native-hidden");
      }
      nativeElements.clear();
      nativeHidden = false;
      return;
    }

    for (const root of openRoots()) {
      ensureNativeStyle(root);
      const elements = [
        ...(root.querySelectorAll?.(NATIVE_SELECTORS) || []),
        ...(root.querySelectorAll?.("video") || []),
      ];
      for (const element of elements) {
        if (!nativeElements.has(element)) {
          nativeElements.set(element, element.hasAttribute("data-dds-native-hidden"));
        }
        element.setAttribute("data-dds-native-hidden", "");
      }
    }
    nativeHidden = true;
  }

  function playbackTimeMs(video) {
    if (awaitingSeekTimeline) return null;
    if (timeline?.interstitial) return null;
    if (timeline) {
      if (timeline.video === video) {
        const synchronized = core.synchronizedTimeMs(
          timeline.timeMs,
          timeline.videoTimeMs,
          video.currentTime * 1000,
          settings.timeOffset * 1000,
        );
        if (synchronized !== null) return synchronized;
      }
      const elapsed = video.paused
        ? 0
        : Math.max(0, performance.now() - timeline.receivedAt) * (video.playbackRate || 1);
      return timeline.timeMs + elapsed - settings.timeOffset * 1000;
    }
    return video.currentTime * 1000 - settings.timeOffset * 1000;
  }

  function scheduleVideoFrame(video) {
    if (typeof video.requestVideoFrameCallback !== "function") return;
    if (videoFrameVideo !== video) {
      if (
        videoFrameVideo &&
        videoFrameHandle !== null &&
        typeof videoFrameVideo.cancelVideoFrameCallback === "function"
      ) {
        videoFrameVideo.cancelVideoFrameCallback(videoFrameHandle);
      }
      videoFrameVideo = video;
      videoFrameHandle = null;
    }
    if (videoFrameHandle !== null) return;
    videoFrameHandle = video.requestVideoFrameCallback(() => {
      videoFrameHandle = null;
      if (videoFrameVideo === video) renderFrame(video);
    });
  }

  function cancelVideoFrameLoop() {
    if (
      videoFrameVideo &&
      videoFrameHandle !== null &&
      typeof videoFrameVideo.cancelVideoFrameCallback === "function"
    ) {
      videoFrameVideo.cancelVideoFrameCallback(videoFrameHandle);
    }
    videoFrameVideo = null;
    videoFrameHandle = null;
  }

  function renderFrame(preferredVideo = null) {
    if (!settings.enabled) {
      hideOverlay();
      setNativeCaptionsHidden(false);
      return;
    }
    const video = preferredVideo?.isConnected ? preferredVideo : findBestVideo();
    if (!video || video.readyState < 1) {
      hideOverlay();
      return;
    }
    scheduleVideoFrame(video);
    const timeMs = playbackTimeMs(video);
    if (timeMs === null) {
      hideOverlay();
      return;
    }

    const topText = core.activeText(state.topCues, timeMs);
    const bottomText = core.activeText(state.bottomCues, timeMs);
    const view = ensureOverlay(video);
    if (!view) return;
    view.host.style.setProperty("--dds-top-size", `${settings.topFontSize}px`);
    view.host.style.setProperty("--dds-bottom-size", `${settings.bottomFontSize}px`);
    view.host.style.setProperty("--dds-position", `${settings.position}%`);
    view.host.style.setProperty("--dds-bg", String(settings.backgroundOpacity));
    view.host.style.setProperty("--dds-top", settings.topColor);
    view.host.style.setProperty("--dds-bottom", settings.bottomColor);
    if (view.top.textContent !== topText) view.top.textContent = topText;
    if (view.bottom.textContent !== bottomText) view.bottom.textContent = bottomText;
    view.host.style.display = topText || bottomText ? "block" : "none";

    const ownsTopLine = state.topCues.length > 0;
    setNativeCaptionsHidden(settings.hideNative && ownsTopLine);
  }

  function resetForRoute(nextRouteKey) {
    routeKey = nextRouteKey;
    manifestGeneration += 1;
    loadGeneration += 1;
    timeline = null;
    state.tracks = [];
    state.topCues = [];
    state.bottomCues = [];
    state.loading = false;
    backgroundRefreshInFlight = false;
    state.error = null;
    state.status = "已換片，等待新的 Disney+ 字幕資料…";
    selectedTopId = null;
    selectedBottomId = null;
    externalTrack = null;
    attemptedManifestUrls.clear();
    cueCache.clear();
    cuePromises.clear();
    segmentCueCache.clear();
    playlistSignatures.clear();
    segmentOwners.clear();
    segmentBaseOwners.clear();
    segmentFetchPromises.clear();
    loadProgress.clear();
    setNativeCaptionsHidden(false);
    hideOverlay();
  }

  function snapshot() {
    return {
      ok: true,
      routeKey,
      status: state.status,
      loading: state.loading,
      error: state.error,
      tracks: state.tracks.map(({ id, language, label, kind, forced }) => ({
        id,
        language,
        label,
        kind,
        forced,
      })),
      selectedTopId,
      selectedBottomId,
      externalTrack: externalTrack
        ? { id: EXTERNAL_TRACK_ID, name: externalTrack.name, cueCount: externalTrack.cues.length }
        : null,
      settings,
    };
  }

  async function handleCommand(message) {
    switch (message?.type) {
      case "DDS_GET_STATE":
        return snapshot();
      case "DDS_SET_ENABLED":
        settings = { ...settings, enabled: Boolean(message.enabled) };
        await persistSettings();
        renderFrame();
        return snapshot();
      case "DDS_SET_SETTINGS":
        settings = sanitizeSettings({ ...settings, ...(message.patch || {}) });
        await persistSettings();
        renderFrame();
        return snapshot();
      case "DDS_SELECT_TRACKS": {
        const top = getTrack(message.topId);
        const bottom =
          message.bottomId === EXTERNAL_TRACK_ID ? null : getTrack(message.bottomId);
        if (top) {
          selectedTopId = top.id;
          settings = { ...settings, topPreference: trackPreference(top) };
        }
        if (message.bottomId === EXTERNAL_TRACK_ID && externalTrack) {
          selectedBottomId = EXTERNAL_TRACK_ID;
        } else if (bottom) {
          selectedBottomId = bottom.id;
          settings = { ...settings, bottomPreference: trackPreference(bottom) };
        }
        await persistSettings();
        startSelectedTrackLoad();
        return snapshot();
      }
      case "DDS_IMPORT_SUBTITLE": {
        if (typeof message.text !== "string" || message.text.length > 4_000_000) {
          throw new Error("字幕檔案無效或超過 4 MB");
        }
        const cues = core.parseExternalSubtitle(message.text, message.language || "und");
        if (!cues.length) throw new Error("無法解析這個 SRT/VTT 字幕檔");
        externalTrack = {
          name: typeof message.name === "string" ? message.name : "外掛字幕",
          cues,
        };
        selectedBottomId = EXTERNAL_TRACK_ID;
        startSelectedTrackLoad();
        return snapshot();
      }
      case "DDS_CLEAR_EXTERNAL":
        externalTrack = null;
        selectedBottomId = chooseTrack(
          settings.bottomPreference,
          ["zh-hant", "zh-tw", "繁體", "繁中", "chinese"],
          selectedTopId,
        )?.id || null;
        startSelectedTrackLoad();
        return snapshot();
      default:
        throw new Error("未知的擴充功能指令");
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !String(message?.type || "").startsWith("DDS_")) {
      return undefined;
    }
    void handleCommand(message).then(
      (result) => sendResponse(result),
      (error) => sendResponse({ ok: false, error: error?.message || String(error) }),
    );
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]?.newValue) return;
    settings = sanitizeSettings(changes[STORAGE_KEY].newValue);
    renderFrame();
  });

  async function initialize() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    settings = sanitizeSettings(stored[STORAGE_KEY]);
    requestBridgeReplay();
    renderTimer = window.setInterval(renderFrame, 100);
    routeTimer = window.setInterval(() => {
      const nextRouteKey = currentRouteKey();
      if (nextRouteKey !== routeKey) resetForRoute(nextRouteKey);
    }, 500);
    nativeTimer = window.setInterval(() => {
      if (settings.enabled && settings.hideNative && state.topCues.length) {
        setNativeCaptionsHidden(true, true);
      }
    }, 1000);
    playlistTimer = window.setInterval(() => {
      const video = findBestVideo();
      if (
        settings.enabled &&
        document.visibilityState !== "hidden" &&
        video &&
        !video.paused &&
        !video.seeking &&
        !awaitingSeekTimeline
      ) {
        refreshSelectedTracks({ silent: true });
      }
    }, PLAYLIST_REFRESH_MS);
    document.addEventListener("fullscreenchange", renderFrame);
    window.addEventListener(
      "pagehide",
      () => {
        clearInterval(renderTimer);
        clearInterval(routeTimer);
        clearInterval(nativeTimer);
        clearInterval(playlistTimer);
        for (const timer of seekTimers) clearTimeout(timer);
        seekTimers.clear();
        cancelVideoFrameLoop();
        setNativeCaptionsHidden(false);
        overlay?.host.remove();
      },
      { once: true },
    );
  }

  void initialize();
})();
