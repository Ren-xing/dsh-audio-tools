# Changelog

All notable changes to `dsh-audio-tools`. Version numbers follow semver;
the plugin id (`dsh-audio`) is stable across all releases.

## 0.1.3 — 2026-11-10

Documentation fix only; no runtime code changes.

- Fix broken screenshots on the npm package page: the README used relative paths
  (`assets/screenshot-1-hero.png`), which npm resolves against `www.npmjs.com` and therefore 404s.
  Links are now absolute and served by unpkg, so they render on both npm and GitHub.
  修 npm 页面上 README 截图裂图的问题：原来用相对路径，npm 会解析成 npmjs.com 上的地址而 404；
  现在改成 unpkg 绝对地址，npm 和 GitHub 上都能显示。

## 0.1.2 — 2026-11-09

Documentation and packaging only; no runtime code changes.

- Ship `README.en.md`, `assets/` (icon + 3 storefront screenshots) and `screenshots.json`
  in the npm tarball, so the npm page shows the English README and the images.
  把英文 README、图标和 3 张市场截图打进 npm 包，npm 页面也能看到图和英文说明。
- README: add an "install from npm" path (`dsh plugin --profile desktop add dsh-audio-tools`);
  installing a local tarball is now option B.
  README 增加「从 npm 安装」的方式，本地 tgz 安装降为方式 B。
- Fix stale version numbers in the install snippets (0.1.0 / 0.1.1 → 0.1.2).
  修正安装示例里过期的版本号。

## 0.1.1 — 2026-11-01

- Align the package version with what was published on npm.
  版本号与 npm 上已发布的版本对齐。
- Add `dsh.bundle` patch entry, keywords, `engines` and repository metadata required by the
  plugin market. 补齐插件市场收录需要的 `dsh.bundle`、keywords、engines 与仓库信息。

## 0.1.0 — 2026-10-28

First public release. 首次发布。

- `audio_probe` — container, duration, bitrate, sample rate, channels, tags, streams.
  查看容器、时长、码率、采样率、声道、标签与流信息。
- `audio_convert` — transcode between mp3/wav/flac/m4a/aac/ogg/opus/wma/aiff, extract the audio
  track from a video, trim, resample, downmix to mono, loudness normalization.
  格式互转、从视频抽音轨、裁剪、重采样、转单声道、响度归一化。
- `audio_transcribe` — speech to text with local whisper.cpp or any OpenAI-compatible API,
  optional `.txt` / `.srt` output.
  本地 whisper.cpp 或任意 OpenAI 兼容接口转写，可输出 `.txt` / `.srt`。
- Zero npm dependencies; requires a local `ffmpeg` / `ffprobe` and does not bundle or download
  binaries (the whisper model installer is opt-in).
  零 npm 依赖；需要本机 ffmpeg/ffprobe，不捆绑也不自动下载二进制（模型安装脚本需手动运行）。
