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
vot-local install      add "Перевести (VOT)" to the Explorer context menu (Windows)
vot-local uninstall    remove it
```

Options: `--lang` (source, default `auto`), `--reslang` (`ru`, `en`, `kk`), `--original-volume` (0..1, default 0.2), `--lively-voice` with `--api-token` or `VOT_API_TOKEN`, `--keep-audio`, `--pause`. Run `vot-local --help` for details.

`ffmpeg`, `ffprobe` and `cloudflared` are taken from the folder of the executable first, then from `PATH`.

## Privacy

Only the audio track is served (metadata and chapters stripped), never the video. It is downloaded and processed by the Yandex translation service and passes through Cloudflare's TryCloudflare service. The URL contains 128 random bits and works only while the translation runs; anyone who learns it during that time can download the audio. Do not translate recordings you are not allowed to share with these services.

## Notes

- The tunnel hostname is used only after cloudflared reports a registered edge connection: resolving it earlier gets a negative DNS answer that resolvers cache for minutes.
- Long videos come back as `PART_CONTENT` first; vot-local keeps polling until the full track is ready (3 h limit).
- All original audio tracks are kept after the dubbed one; a surround original is mixed down to stereo for the dub.
- The result is written as `<name>.<lang>.mkv.part` and renamed when complete; Ctrl+C or closing the window removes temporary files and stops the tunnel.
- Tested end to end on Linux. The Windows build was checked under Wine up to the tunnel, since Wine lacks the DNS SRV lookup cloudflared needs.

## Windows package

`vot-local-windows.zip` contains `vot-local.exe`, `ffmpeg.exe`, `ffprobe.exe`, `cloudflared.exe`, `install.cmd` (adds the context menu entry for the current user, no admin rights), `uninstall.cmd` and a Russian `README.txt`. Check the archive before unpacking with `certutil -hashfile vot-local-windows.zip SHA256` against the hash published with the release; `SHA256SUMS` inside checks the unpacked files.

## Development

```
bun install
bun test
bun run check
bun run lint
bun run package:windows   # needs vendor/windows/{ffmpeg,ffprobe,cloudflared}.exe and their licenses
```

## License

MIT. The Windows package bundles FFmpeg (LGPL v3 build from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), source links in `docs/FFmpeg-SOURCE.txt`), [cloudflared](https://github.com/cloudflare/cloudflared) (Apache 2.0) and the Bun runtime inside `vot-local.exe`; license texts and third-party notices are in `licenses/`.
