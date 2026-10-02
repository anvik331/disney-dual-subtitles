/opt/homebrew/Library/Homebrew/cmd/shellenv.sh: line 18: /bin/ps: Operation not permitted
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("replays a manifest URL when the content script becomes ready", () => {
  const manifestUrl = "https://media.dssott.com/video/master.m3u8";
  const posted = [];
  const listeners = new Map();
  const intervals = [];
  const location = {
    origin: "https://www.disneyplus.com",
    href: "https://www.disneyplus.com/play/abc",
    pathname: "/play/abc",
    search: "",
  };
  const window = {
    fetch: () => Promise.reject(new Error("not used")),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    postMessage(message) {
      posted.push(message);
    },
    setInterval(callback) {
      intervals.push(callback);
      return intervals.length;
    },
  };
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function open() {};
  XMLHttpRequest.prototype.send = function send() {};

  const source = fs.readFileSync(path.join(__dirname, "..", "bridge.js"), "utf8");
  vm.runInNewContext(source, {
    URL,
    Request: class Request {},
    XMLHttpRequest,
    document: { querySelector: () => null },
    location,
    performance: { getEntriesByType: () => [{ name: manifestUrl }] },
    window,
  });

  assert.equal(
    posted.filter((message) => message.type === "manifest-url").length,
    1,
    "the first announcement happens before the content listener is ready",
  );
  posted.length = 0;

  listeners.get("message")({
    source: window,
    origin: location.origin,
    data: {
      source: "disney-dual-subtitles-content",
      version: 1,
      type: "ready",
      routeKey: "/play/abc",
    },
  });

  assert.deepEqual(
    posted.filter((message) => message.type === "manifest-url").map((message) => message.url),
    [manifestUrl],
  );
});

test("publishes the current Disney timeline again after a seek", () => {
  const posted = [];
  const listeners = new Map();
  const location = {
    origin: "https://www.disneyplus.com",
    href: "https://www.disneyplus.com/play/abc",
    pathname: "/play/abc",
    search: "",
  };
  const window = {
    fetch: () => Promise.reject(new Error("not used")),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    postMessage(message) {
      posted.push(message);
    },
    setInterval() {
      return 1;
    },
  };
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function open() {};
  XMLHttpRequest.prototype.send = function send() {};
  const player = {
    mediaPlayerApi: { timeline: { info: { playheadPositionMs: 945_000 } } },
  };

  const source = fs.readFileSync(path.join(__dirname, "..", "bridge.js"), "utf8");
  vm.runInNewContext(source, {
    URL,
    Request: class Request {},
    XMLHttpRequest,
    document: {
      querySelector(selector) {
        return selector === "disney-web-player-ui" ? player : null;
      },
    },
    location,
    performance: { getEntriesByType: () => [] },
    window,
  });

  assert.equal(posted.filter((message) => message.type === "timeline").length, 1);
  listeners.get("message")({
    source: window,
    origin: location.origin,
    data: {
      source: "disney-dual-subtitles-content",
      version: 1,
      type: "timeline-request",
      routeKey: "/play/abc",
    },
  });
  assert.deepEqual(
    posted
      .filter((message) => message.type === "timeline")
      .map((message) => [message.timeMs, message.sequence]),
    [
      [945_000, 1],
      [945_000, 2],
    ],
  );
});

test("forwards newly requested Disney WebVTT segments", async () => {
  const segmentUrl = "https://media.dssott.com/subtitles/en/pts_16200000.vtt";
  const raw = `WEBVTT\n\n00:03:01.000 --> 00:03:03.000\nLater cue\n`;
  const posted = [];
  const location = {
    origin: "https://www.disneyplus.com",
    href: "https://www.disneyplus.com/play/abc",
    pathname: "/play/abc",
    search: "",
  };
  const response = {
    ok: true,
    url: segmentUrl,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type" ? "text/vtt" : null;
      },
    },
    clone() {
      return { text: async () => raw };
    },
  };
  const window = {
    fetch: async () => response,
    addEventListener() {},
    postMessage(message) {
      posted.push(message);
    },
    setInterval() {
      return 1;
    },
  };
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function open() {};
  XMLHttpRequest.prototype.send = function send() {};

  const source = fs.readFileSync(path.join(__dirname, "..", "bridge.js"), "utf8");
  vm.runInNewContext(source, {
    URL,
    Request: class Request {},
    XMLHttpRequest,
    document: { querySelector: () => null },
    location,
    performance: { getEntriesByType: () => [] },
    window,
  });

  await window.fetch(segmentUrl);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    posted
      .filter((message) => message.type === "subtitle-segment")
      .map((message) => [message.url, message.raw]),
    [[segmentUrl, raw]],
  );
});
