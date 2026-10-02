(function attachCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DDSCore = api;
})(typeof globalThis === "undefined" ? this : globalThis, function createCore() {
  "use strict";

  const MPEG_TS_WRAP = 2 ** 33;

  function isAllowedMediaUrl(value) {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        (url.hostname === "media.dssott.com" ||
          url.hostname.endsWith(".media.dssott.com"))
      );
    } catch {
      return false;
    }
  }

  function parseAttributeList(value) {
    const fields = [];
    let field = "";
    let quoted = false;
    for (const character of value) {
      if (character === '"') quoted = !quoted;
      if (character === "," && !quoted) {
        fields.push(field);
        field = "";
      } else {
        field += character;
      }
    }
    if (quoted) return null;
    fields.push(field);

    const result = {};
    for (const item of fields) {
      const separator = item.indexOf("=");
      if (separator <= 0) return null;
      const key = item.slice(0, separator).trim().toUpperCase();
      let content = item.slice(separator + 1).trim();
      if (content.startsWith('"') || content.endsWith('"')) {
        if (!(content.startsWith('"') && content.endsWith('"'))) return null;
        content = content.slice(1, -1);
      }
      if (!key || Object.hasOwn(result, key)) return null;
      result[key] = content;
    }
    return result;
  }

  function canonicalLanguage(value) {
    try {
      return Intl.getCanonicalLocales(value)[0] || "und";
    } catch {
      return value.trim() || "und";
    }
  }

  function parseMasterManifest(raw, manifestUrl) {
    const normalized = String(raw).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (!normalized.startsWith("#EXTM3U")) return [];

    const tracks = [];
    const seen = new Set();
    for (const line of normalized.split("\n")) {
      if (!line.startsWith("#EXT-X-MEDIA:")) continue;
      const attributes = parseAttributeList(line.slice("#EXT-X-MEDIA:".length));
      if (!attributes || attributes.TYPE !== "SUBTITLES" || !attributes.URI) continue;

      let playlistUrl;
      try {
        playlistUrl = new URL(attributes.URI, manifestUrl).href;
      } catch {
        continue;
      }
      if (!isAllowedMediaUrl(playlistUrl)) continue;

      const language = canonicalLanguage(attributes.LANGUAGE || "und");
      const label = (attributes.NAME || language).trim();
      const forced = attributes.FORCED === "YES";
      const accessibility = attributes.CHARACTERISTICS || "";
      const closedCaptions = accessibility.includes(
        "public.accessibility.describes-music-and-sound",
      );
      const kind = forced ? "forced" : closedCaptions ? "cc" : "subtitle";
      const signature = `${language}\u0000${kind}\u0000${label}\u0000${playlistUrl}`;
      if (seen.has(signature)) continue;
      seen.add(signature);

      tracks.push({
        id: `official:${tracks.length}:${language}:${kind}`,
        language,
        label,
        kind,
        forced,
        playlistUrl,
      });
    }
    return tracks;
  }

  function parseDurationMs(line) {
    const match = line.match(/^#EXTINF:(\d+(?:\.\d+)?),?/);
    if (!match) return null;
    const duration = Number(match[1]) * 1000;
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  }

  function ptsFromUrl(value) {
    try {
      const match = new URL(value).pathname.match(/\/pts_(\d+)\.(?:vtt|webvtt)$/i);
      if (!match) return null;
      const pts = Number(match[1]);
      return Number.isSafeInteger(pts) && pts >= 0 ? pts : null;
    } catch {
      return null;
    }
  }

  function parseMediaPlaylist(raw, playlistUrl) {
    const normalized = String(raw).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (!normalized.startsWith("#EXTM3U")) return [];

    const segments = [];
    let pendingDurationMs = null;
    let elapsedMs = 0;
    for (const untrimmed of normalized.split("\n")) {
      const line = untrimmed.trim();
      if (!line) continue;
      if (line.startsWith("#EXTINF:")) {
        pendingDurationMs = parseDurationMs(line);
        continue;
      }
      if (line.startsWith("#")) continue;
      if (pendingDurationMs === null) continue;

      let url;
      try {
        url = new URL(line, playlistUrl).href;
      } catch {
        pendingDurationMs = null;
        continue;
      }
      if (!isAllowedMediaUrl(url)) {
        pendingDurationMs = null;
        continue;
      }
      segments.push({
        url,
        durationMs: pendingDurationMs,
        elapsedMs,
        pts: ptsFromUrl(url),
      });
      elapsedMs += pendingDurationMs;
      pendingDurationMs = null;
    }
    return segments;
  }

  function parseTimestamp(value) {
    const cleaned = String(value).trim().replace(",", ".");
    const parts = cleaned.split(":");
    if (parts.length !== 2 && parts.length !== 3) return null;
    const hours = parts.length === 3 ? Number(parts[0]) : 0;
    const minutes = Number(parts.at(-2));
    const secondsMatch = parts.at(-1).match(/^(\d{1,2})(?:\.(\d{1,3}))?$/);
    if (
      !Number.isInteger(hours) ||
      hours < 0 ||
      !Number.isInteger(minutes) ||
      minutes < 0 ||
      minutes >= 60 ||
      !secondsMatch
    ) {
      return null;
    }
    const seconds = Number(secondsMatch[1]);
    if (seconds >= 60) return null;
    const milliseconds = Number((secondsMatch[2] || "0").padEnd(3, "0"));
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
  }

  function unwrapMpegDelta(delta) {
    const wrapped = ((delta % MPEG_TS_WRAP) + MPEG_TS_WRAP) % MPEG_TS_WRAP;
    return wrapped > MPEG_TS_WRAP / 2 ? wrapped - MPEG_TS_WRAP : wrapped;
  }

  function decodeEntities(value) {
    const named = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      nbsp: "\u00a0",
      quot: '"',
    };
    return value.replace(
      /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
      (entity, decimal, hexadecimal, name) => {
        const point = decimal
          ? Number(decimal)
          : hexadecimal
            ? Number.parseInt(hexadecimal, 16)
            : null;
        if (point !== null) {
          try {
            return String.fromCodePoint(point);
          } catch {
            return entity;
          }
        }
        return named[String(name).toLowerCase()] || entity;
      },
    );
  }

  function cleanCueText(raw) {
    return decodeEntities(
      String(raw)
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]*>/g, ""),
    )
      .split("\n")
      .map((line) => line.replace(/[\s\u00a0]+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  }

  function firstCueStartMs(raw) {
    const match = String(raw).match(/^(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->/m);
    return match ? parseTimestamp(match[1]) : null;
  }

  function usesAbsoluteCueTimes(raw, fallbackOffsetMs) {
    const firstStart = firstCueStartMs(raw);
    return Boolean(
      fallbackOffsetMs > 10_000 &&
        firstStart !== null &&
        firstStart > 10_000 &&
        Math.abs(firstStart - fallbackOffsetMs) < 120_000,
    );
  }

  function timestampOffset(raw, anchor, fallbackOffsetMs) {
    const absoluteCues = usesAbsoluteCueTimes(raw, fallbackOffsetMs || 0);
    const map = raw.match(/^X-TIMESTAMP-MAP=(.+)$/m)?.[1];
    if (!map) return absoluteCues ? 0 : fallbackOffsetMs || 0;
    const localText = map.match(/(?:^|,)LOCAL:([^,]+)/)?.[1];
    const mpegText = map.match(/(?:^|,)MPEGTS:(\d+)/)?.[1];
    const localMs = localText ? parseTimestamp(localText) : null;
    const mappedPts = mpegText ? Number(mpegText) : NaN;
    if (localMs === null || !Number.isSafeInteger(mappedPts)) return null;
    if (!anchor) {
      if (absoluteCues) return 0;
      if (localMs === 0 && mappedPts === 0) return 0;
      const mappedOffset = mappedPts / 90 - localMs;
      if (Number.isFinite(mappedOffset) && mappedOffset >= 0) return mappedOffset;
      return fallbackOffsetMs || 0;
    }
    const delta = unwrapMpegDelta(mappedPts - anchor.mpegTs);
    return anchor.presentationTimeMs + delta / 90 - localMs;
  }

  function parseWebVtt(raw, options = {}) {
    const normalized = String(raw).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (!normalized.startsWith("WEBVTT")) return [];
    const offset = timestampOffset(
      normalized,
      options.anchor || null,
      options.fallbackOffsetMs || 0,
    );
    if (offset === null) return [];

    const cues = [];
    for (const block of normalized.split(/\n{2,}/)) {
      const lines = block.split("\n");
      if (/^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0] || "")) continue;
      const index = lines.findIndex((line) => line.includes("-->"));
      if (index < 0) continue;
      const match = lines[index].match(/^(\S+)\s+-->\s+(\S+)/);
      if (!match) continue;
      const localStart = parseTimestamp(match[1]);
      const localEnd = parseTimestamp(match[2]);
      const text = cleanCueText(lines.slice(index + 1).join("\n"));
      if (localStart === null || localEnd === null || localEnd <= localStart || !text) {
        continue;
      }
      const start = localStart + offset;
      const end = localEnd + offset;
      if (start < 0 || end <= start) continue;
      cues.push({ start, end, text, language: options.language || "und" });
    }
    return cues.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function parseSrt(raw, language = "und") {
    const normalized = String(raw).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const cues = [];
    for (const block of normalized.split(/\n{2,}/)) {
      const lines = block.split("\n").filter((line, index) => index > 0 || line.trim());
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) continue;
      const match = lines[timingIndex].match(/^(\S+)\s+-->\s+(\S+)/);
      if (!match) continue;
      const start = parseTimestamp(match[1]);
      const end = parseTimestamp(match[2]);
      const text = cleanCueText(lines.slice(timingIndex + 1).join("\n"));
      if (start === null || end === null || end <= start || !text) continue;
      cues.push({ start, end, text, language });
    }
    return normalizeCues(cues);
  }

  function parseExternalSubtitle(raw, language = "und") {
    return String(raw).replace(/^\uFEFF/, "").startsWith("WEBVTT")
      ? normalizeCues(parseWebVtt(raw, { language }))
      : parseSrt(raw, language);
  }

  function normalizeCues(cues) {
    const result = [];
    const seen = new Set();
    for (const cue of [...cues].sort((a, b) => a.start - b.start || a.end - b.end)) {
      if (
        !Number.isFinite(cue.start) ||
        !Number.isFinite(cue.end) ||
        cue.start < 0 ||
        cue.end <= cue.start ||
        !cue.text
      ) {
        continue;
      }
      const signature = `${cue.start}\u0000${cue.end}\u0000${cue.text}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      result.push(cue);
    }
    return result;
  }

  function mergeCueWindows(...windows) {
    return normalizeCues(windows.flat());
  }

  function upperBoundStart(cues, timeMs) {
    let low = 0;
    let high = cues.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (cues[middle].start <= timeMs) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function activeText(cues, timeMs) {
    if (!cues.length || !Number.isFinite(timeMs)) return "";
    const end = upperBoundStart(cues, timeMs);
    const active = [];
    for (let index = end - 1; index >= 0; index -= 1) {
      const cue = cues[index];
      if (cue.end <= timeMs) {
        if (active.length) break;
        continue;
      }
      if (cue.start <= timeMs && timeMs < cue.end) active.unshift(cue.text);
      if (active.length >= 4) break;
    }
    return [...new Set(active)].join("\n");
  }

  function synchronizedTimeMs(
    timelineTimeMs,
    timelineVideoTimeMs,
    currentVideoTimeMs,
    offsetMs = 0,
  ) {
    if (
      !Number.isFinite(timelineTimeMs) ||
      !Number.isFinite(timelineVideoTimeMs) ||
      !Number.isFinite(currentVideoTimeMs) ||
      !Number.isFinite(offsetMs)
    ) {
      return null;
    }
    return timelineTimeMs + (currentVideoTimeMs - timelineVideoTimeMs) - offsetMs;
  }

  return {
    MPEG_TS_WRAP,
    activeText,
    canonicalLanguage,
    firstCueStartMs,
    isAllowedMediaUrl,
    mergeCueWindows,
    normalizeCues,
    parseAttributeList,
    parseExternalSubtitle,
    parseMasterManifest,
    parseMediaPlaylist,
    parseTimestamp,
    parseWebVtt,
    ptsFromUrl,
    synchronizedTimeMs,
    usesAbsoluteCueTimes,
  };
});
