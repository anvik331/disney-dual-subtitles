"use strict";

const MAX_RESPONSE_BYTES = 2_500_000;

function isAllowedUrl(value) {
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

async function readBoundedText(response) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error("字幕資源超過大小限制");
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("字幕資源超過大小限制");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("字幕資源超過大小限制");
    }
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

async function fetchText(url, forceRefresh = false) {
  if (!isAllowedUrl(url)) throw new Error("拒絕非 Disney 字幕網域");
  const response = await fetch(url, {
    cache: forceRefresh ? "no-store" : "default",
    credentials: "omit",
    redirect: "follow",
  });
  if (!isAllowedUrl(response.url || url)) throw new Error("字幕請求被重新導向至未知網域");
  if (!response.ok) throw new Error(`字幕請求失敗（HTTP ${response.status}）`);
  return { text: await readBoundedText(response), url: response.url || url };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message?.type !== "DDS_FETCH_TEXT" ||
    sender.id !== chrome.runtime.id ||
    typeof message.url !== "string"
  ) {
    return undefined;
  }

  void fetchText(message.url, message.forceRefresh === true).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: error?.message || String(error) }),
  );
  return true;
});
