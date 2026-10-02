# Privacy

Disney+ Dual Subtitles does not operate a server and does not collect analytics,
account details, viewing history, subtitle text, or personal information.

The extension processes subtitle manifests and WebVTT/SRT text locally in the
browser. Display preferences are stored in `chrome.storage.local`. Imported
subtitle files are held only in the active Disney+ tab's memory and are cleared
when the playback route changes or the tab closes.

The extension sends network requests only to Disney's `media.dssott.com`
subtitle hosts for resources already referenced by the active playback session.
It does not download video, bypass DRM, or contact a translation provider.
