# vot-local

Translate local video files with Yandex voice-over translation ([vot.js](https://github.com/FOSWLY/vot.js)) and get a `.mkv` with a dubbed audio track that plays in any player.

The translation backend downloads media by URL, so a local file has to be reachable from the internet while it is translated. vot-local extracts the audio track, serves it from `127.0.0.1` under a random path and exposes it through a temporary [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/). When the translation is ready, the tunnel is closed and the dubbed track is muxed next to the original:

```
lecture.mp4 -> lecture.ru.mkv
  video     copied
  audio 1   translation over the original at 20 % (default)
  audio 2   original
  subtitles copied when the container allows it
```

## Usage

```
vot-local [options] <video> [video2 ...]
vot-local install [--potplayer <exe>]   add the "VOT" submenu to the Explorer context menu (Windows)
vot-local uninstall                     remove it
```

Options: `--lang` (source, default `auto`), `--reslang` (`ru`, `en`, `kk`), `--format` (`mkv` default, `mp4` for Media Foundation players, `m4a` dubbed audio only), `--original-volume` (0..1, default 0.2), `--lively-voice` with `--api-token` or `VOT_API_TOKEN`, `--keep-audio`, `--open`, `--open-with <exe>`, `--result-file <path>`, `--pause`, `--pause-on-error`. Run `vot-local --help` for details.

## Players

| Player | Integration |
|---|---|
| Any default player | Explorer submenu "VOT: закадровый перевод" → "Перевести и открыть" (mkv, opened with the default app) |
| Windows 11 Media Player, Windows Server 2025 | "Перевести для Медиаплеера Windows (mp4)": mp4 with AAC tracks; the video is copied when it is 8-bit 4:2:0 H.264, otherwise re-encoded to MPEG-4 Part 2 with the bundled LGPL FFmpeg |
| PotPlayer | "Перевести и открыть в PotPlayer", added when `install` finds PotPlayer under Program Files (or with `--potplayer`) |
| AIMP | native plugin `plugins/aimp` (x86 + x64, package `vot_local.aimppack`): "Перевести (VOT)" in the playlist context menu runs `vot-local --format m4a` and adds the result to the playlist |

The new Windows 11 Media Player has no plug-in API, and the legacy Windows Media Player SDK is deprecated, so the Windows players are integrated through the Explorer menu. PotPlayer has no documented plug-in API for local files; since the dubbed track is the first audio track of the mkv, opening the result is enough. `install` stores the install folder in `HKCU\Software\vot-local\InstallPath`, which the AIMP plugin reads.

`ffmpeg`, `ffprobe` and `cloudflared` are taken from the folder of the executable first, then from `PATH`.

## Privacy

Only the audio track is served (metadata and chapters stripped), never the video. It is downloaded and processed by the Yandex translation service and passes through Cloudflare's TryCloudflare service. The URL contains 128 random bits and works only while the translation runs; anyone who learns it during that time can download the audio. Do not translate recordings you are not allowed to share with these services.

## Notes

- The tunnel hostname is used only after cloudflared reports a registered edge connection: resolving it earlier gets a negative DNS answer that resolvers cache for minutes.
- Long videos come back as `PART_CONTENT` first; vot-local keeps polling until the full track is ready (3 h limit).
- All original audio tracks are kept after the dubbed one; a surround original is mixed down to stereo for the dub.
- The result is written as `<name>.<lang>.mkv.part` and renamed when complete; Ctrl+C or closing the window removes temporary files and stops the tunnel.
- Tested end to end on Linux and on Windows. Under Wine the Windows build runs up to the tunnel, since Wine lacks the DNS SRV lookup cloudflared needs.

## Windows package

`vot-local-windows.zip` contains `vot-local.exe`, `ffmpeg.exe`, `ffprobe.exe`, `cloudflared.exe`, `install.cmd` (adds the context menu entry for the current user, no admin rights), `uninstall.cmd` and a Russian `README.txt`. Check the archive before unpacking with `certutil -hashfile vot-local-windows.zip SHA256` against the hash published with the release; `SHA256SUMS` inside checks the unpacked files.

## Development

```
bun install
bun test
bun run check
bun run lint
LLVM_MINGW=/path/to/llvm-mingw bun scripts/build-aimp.ts   # AIMP plugin; downloads and checks the AIMP SDK 5.40
LLVM_MINGW=/path/to/llvm-mingw bun scripts/test-aimp.ts    # loads the x64 plugin in a fake AIMP host under Wine
bun run package:windows   # needs vendor/windows/{ffmpeg,ffprobe,cloudflared}.exe, their licenses and the AIMP pack
```

The AIMP plugin is built with [llvm-mingw](https://github.com/mstorsjo/llvm-mingw); the AIMP SDK headers are downloaded at build time and not stored in the repository.

## License

MIT. The Windows package bundles FFmpeg (LGPL v3 build from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), source links in `docs/FFmpeg-SOURCE.txt`), [cloudflared](https://github.com/cloudflare/cloudflared) (Apache 2.0) and the Bun runtime inside `vot-local.exe`; license texts and third-party notices are in `licenses/`.
