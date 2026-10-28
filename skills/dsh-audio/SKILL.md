---
name: dsh-audio
description: 用 ffmpeg 查看音频/视频信息、转换格式、从视频提取音轨、裁剪与响度归一化，并用 whisper.cpp 或 OpenAI 兼容接口转写语音。
---

# dsh-audio

本技能提供三个工具，全部基于本机 ffmpeg/ffprobe（插件不自带二进制）。

| 工具 | 什么时候用 |
| --- | --- |
| `audio_probe` | 先看清楚文件里有什么：容器、时长、码率、采样率、声道、标签、是否带视频轨 |
| `audio_convert` | 转格式、从视频里抽音轨、裁剪、重采样、单声道、响度归一化（loudnorm） |
| `audio_transcribe` | 语音转文字，可顺带写 `.txt` / `.srt` 字幕 |

## 调用顺序

1. 拿到一个陌生文件，先 `audio_probe`。确认 `hasAudio`，记住 `audioStreams[0]` 的采样率/声道，以及有没有视频轨。
2. 要转写或转换时直接用原文件，插件会自动选第 0 条音轨；多音轨用 `audioStream` 指定。
3. 需要字幕时给 `audio_transcribe` 传 `srt: true`，或在 `output` 里写一个 `.srt` 路径。

## audio_probe

```json
{ "path": "D:/media/lecture.mp4" }
```

返回 `durationSec`、`bitrateKbps`、`audioStreams[]`、`videoStreams[]`、`tags`。没有音轨时 `hasAudio=false`。

## audio_convert

```json
{ "input": "D:/media/lecture.mp4", "format": "mp3", "bitrate": "128k", "output": "D:/media/lecture.mp3" }
```

- 从视频提取音轨：给 `format` 即可，插件自动加 `-vn`，不复制视频。
- 裁剪：`start: "00:12:30"`，`duration: 300`（秒）。
- 压缩语音：`sampleRate: 16000`、`channels: 1`，适合再送去转写。
- 音量对齐：`normalize: true`（EBU R128，-16 LUFS）。
- 无损格式（wav/flac/aiff）不接受 `bitrate`。
- 默认输出在输入旁边、同名换扩展名；`config.outputDir` 可改默认目录。
- 不覆盖已有文件；要覆盖必须显式 `overwrite: true`。输入文件永远不会被原地改写（同路径会先写临时文件再替换）。

## audio_transcribe

```json
{ "input": "D:/media/lecture.mp3", "language": "zh", "srt": true }
```

- `backend: "cli"`（默认）走本地 whisper.cpp，离线、按 CPU 速度，长音频较慢。
- `backend: "api"` 走 `config.apiBaseUrl` 的 `/audio/transcriptions`，需要 `config.apiKey`；单文件上限 24 MB。
- `language` 默认取 `config.language`（默认 `zh`），写 `"auto"` 自动检测。
- 返回 `text`、`segments[]`（带起止秒数）、`language`、`srtPath`/`textPath`。
- 专有名词识别不准时，`prompt` 传一段包含术语的提示（仅 cli 后端）。

## 依赖与配置

插件不自带 ffmpeg。缺失时工具会报"ffmpeg was not found"并给出安装方式：

```powershell
winget install --id Gyan.FFmpeg -e
```

装完重启 DSH；如果 ffmpeg 不在 PATH 上，在插件配置里写 `ffmpegPath` / `ffprobePath`。

本地转写需要 whisper-cli 和模型，仓库自带安装脚本：

```powershell
node "<插件目录>/scripts/setup-whisper.mjs" --model small
```

模型可选 `tiny` / `base` / `small` / `medium` / `large-v3`；中文建议 `small` 起步。

## 边界

- 单个文件受 `config.timeoutMs`（默认 10 分钟）限制；超时会被杀掉并报错。
- 转写 API 后端不适合超大文件；先用 `audio_convert` 裁剪/压缩。
- 输出路径由调用方负责可写；目录不存在时会自动创建（仅转写文本/字幕）。
