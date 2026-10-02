"use strict";

const elements = {
  statusCard: document.querySelector("#status-card"),
  statusTitle: document.querySelector("#status-title"),
  statusDetail: document.querySelector("#status-detail"),
  enabled: document.querySelector("#enabled"),
  topTrack: document.querySelector("#top-track"),
  bottomTrack: document.querySelector("#bottom-track"),
  file: document.querySelector("#subtitle-file"),
  clearFile: document.querySelector("#clear-file"),
  fileName: document.querySelector("#file-name"),
  offset: document.querySelector("#offset"),
  offsetValue: document.querySelector("#offset-value"),
  topFontSize: document.querySelector("#top-font-size"),
  topFontSizeValue: document.querySelector("#top-font-size-value"),
  bottomFontSize: document.querySelector("#bottom-font-size"),
  bottomFontSizeValue: document.querySelector("#bottom-font-size-value"),
  position: document.querySelector("#position"),
  positionValue: document.querySelector("#position-value"),
  background: document.querySelector("#background"),
  backgroundValue: document.querySelector("#background-value"),
  topColor: document.querySelector("#top-color"),
  bottomColor: document.querySelector("#bottom-color"),
  hideNative: document.querySelector("#hide-native"),
  reload: document.querySelector("#reload"),
};

let activeTab = null;
let latestState = null;
let selectSignature = "";
let settingsTimer = null;
let pollTimer = null;

function setStatus(kind, title, detail) {
  elements.statusCard.classList.remove("ready", "error");
  if (kind) elements.statusCard.classList.add(kind);
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
}

function send(message) {
  return new Promise((resolve, reject) => {
    if (!activeTab?.id) {
      reject(new Error("找不到目前分頁"));
      return;
    }
    chrome.tabs.sendMessage(activeTab.id, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response?.ok) reject(new Error(response?.error || "擴充功能沒有回應"));
      else resolve(response);
    });
  });
}

function labelForTrack(track) {
  const suffix = track.kind === "cc" ? " · CC" : track.kind === "forced" ? " · 強制" : "";
  return `${track.label} (${track.language})${suffix}`;
}

function renderSelects(state) {
  const signature = JSON.stringify({
    tracks: state.tracks,
    external: state.externalTrack,
  });
  if (signature === selectSignature) {
    elements.topTrack.value = state.selectedTopId || "";
    elements.bottomTrack.value = state.selectedBottomId || "";
    return;
  }
  selectSignature = signature;

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.tracks.length ? "選擇字幕" : "尚未偵測到字幕";
  elements.topTrack.replaceChildren(placeholder.cloneNode(true));
  elements.bottomTrack.replaceChildren(placeholder.cloneNode(true));
  for (const track of state.tracks) {
    const topOption = document.createElement("option");
    topOption.value = track.id;
    topOption.textContent = labelForTrack(track);
    elements.topTrack.append(topOption);
    elements.bottomTrack.append(topOption.cloneNode(true));
  }
  if (state.externalTrack) {
    const option = document.createElement("option");
    option.value = state.externalTrack.id;
    option.textContent = `外掛：${state.externalTrack.name}`;
    elements.bottomTrack.append(option);
  }
  elements.topTrack.value = state.selectedTopId || "";
  elements.bottomTrack.value = state.selectedBottomId || "";
}

function assignUnlessEditing(element, value) {
  if (document.activeElement !== element) element.value = String(value);
}

function renderState(state) {
  latestState = state;
  const ready = !state.loading && !state.error && (state.tracks.length || state.externalTrack);
  setStatus(
    state.error ? "error" : ready ? "ready" : "",
    state.loading ? "正在準備雙字幕" : ready ? "雙字幕已連線" : "等待字幕資料",
    state.status,
  );
  elements.enabled.checked = state.settings.enabled;
  renderSelects(state);

  const settings = state.settings;
  assignUnlessEditing(elements.offset, settings.timeOffset);
  assignUnlessEditing(elements.topFontSize, settings.topFontSize ?? settings.fontSize ?? 28);
  assignUnlessEditing(
    elements.bottomFontSize,
    settings.bottomFontSize ?? settings.fontSize ?? 28,
  );
  assignUnlessEditing(elements.position, settings.position);
  assignUnlessEditing(elements.background, settings.backgroundOpacity);
  assignUnlessEditing(elements.topColor, settings.topColor);
  assignUnlessEditing(elements.bottomColor, settings.bottomColor);
  elements.hideNative.checked = settings.hideNative;
  updateOutputs();

  elements.clearFile.hidden = !state.externalTrack;
  elements.fileName.textContent = state.externalTrack
    ? `${state.externalTrack.name} · ${state.externalTrack.cueCount} 段字幕`
    : "可用自己的字幕取代下方字幕。";
}

function updateOutputs() {
  elements.offsetValue.textContent = `${Number(elements.offset.value).toFixed(1)} 秒`;
  elements.topFontSizeValue.textContent = `${elements.topFontSize.value} px`;
  elements.bottomFontSizeValue.textContent = `${elements.bottomFontSize.value} px`;
  elements.positionValue.textContent = `${elements.position.value}%`;
  elements.backgroundValue.textContent = `${Math.round(Number(elements.background.value) * 100)}%`;
}

function settingsPatch() {
  return {
    timeOffset: Number(elements.offset.value),
    topFontSize: Number(elements.topFontSize.value),
    bottomFontSize: Number(elements.bottomFontSize.value),
    position: Number(elements.position.value),
    backgroundOpacity: Number(elements.background.value),
    topColor: elements.topColor.value,
    bottomColor: elements.bottomColor.value,
    hideNative: elements.hideNative.checked,
  };
}

function scheduleSettingsSave() {
  updateOutputs();
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    void send({ type: "DDS_SET_SETTINGS", patch: settingsPatch() })
      .then(renderState)
      .catch((error) => setStatus("error", "設定無法儲存", error.message));
  }, 120);
}

elements.enabled.addEventListener("change", () => {
  void send({ type: "DDS_SET_ENABLED", enabled: elements.enabled.checked })
    .then(renderState)
    .catch((error) => setStatus("error", "無法切換字幕", error.message));
});

function changeTracks() {
  if (!elements.topTrack.value) return;
  void send({
    type: "DDS_SELECT_TRACKS",
    topId: elements.topTrack.value,
    bottomId: elements.bottomTrack.value,
  })
    .then(renderState)
    .catch((error) => setStatus("error", "無法切換字幕", error.message));
}

elements.topTrack.addEventListener("change", changeTracks);
elements.bottomTrack.addEventListener("change", changeTracks);

for (const input of [
  elements.offset,
  elements.topFontSize,
  elements.bottomFontSize,
  elements.position,
  elements.background,
  elements.topColor,
  elements.bottomColor,
  elements.hideNative,
]) {
  input.addEventListener("input", scheduleSettingsSave);
  input.addEventListener("change", scheduleSettingsSave);
}

elements.file.addEventListener("change", async () => {
  const file = elements.file.files?.[0];
  if (!file) return;
  try {
    setStatus("", "正在解析外掛字幕", file.name);
    const response = await send({
      type: "DDS_IMPORT_SUBTITLE",
      name: file.name,
      text: await file.text(),
    });
    renderState(response);
  } catch (error) {
    setStatus("error", "字幕匯入失敗", error.message);
  } finally {
    elements.file.value = "";
  }
});

elements.clearFile.addEventListener("click", () => {
  void send({ type: "DDS_CLEAR_EXTERNAL" })
    .then(renderState)
    .catch((error) => setStatus("error", "無法移除字幕", error.message));
});

elements.reload.addEventListener("click", () => {
  if (activeTab?.id) chrome.tabs.reload(activeTab.id);
  window.close();
});

async function refresh() {
  try {
    renderState(await send({ type: "DDS_GET_STATE" }));
  } catch (error) {
    setStatus(
      "error",
      "尚未連上 Disney+ 播放頁",
      "請開啟 Disney+ 影片後按下方按鈕重新載入。",
    );
  }
}

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  if (!tab?.url?.startsWith("https://www.disneyplus.com/")) {
    setStatus("error", "目前不是 Disney+", "請在 Disney+ 網頁播放影片後再開啟此面板。");
    for (const control of document.querySelectorAll("input, select")) control.disabled = true;
    return;
  }
  await refresh();
  pollTimer = window.setInterval(refresh, 800);
  window.addEventListener("pagehide", () => clearInterval(pollTimer), { once: true });
}

void initialize();
