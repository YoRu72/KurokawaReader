# Video player research — REX Player, VLC for Android, A/B cut + hardsub

Written 2026-10-31 for the Kurokawa Tools player (Android: libmpv inside a Capacitor app, player screen may be native Kotlin; desktop: Electron).

Sources inspected:

- `mpvRex/REX-Player` at commit `23704eb` (2026-10-31, v5.5.0, versionCode 216), the whole Kotlin tree (`app/src/main/kotlin/xyz/mpv/rex`, 349 files / 112k lines), `AndroidManifest.xml`, `gradle/libs.versions.toml`, `app/build.gradle.kts`, `docs/*.md`, fastlane metadata (still the old mpvExtended text).
- Its libmpv fork `mpvRex/mpvRex-libmpv` at commit `4b4ecf0` (2026-09-02): `buildscripts/`, `app/src/main/jni/*.cpp`, `app/src/main/java/is/xyz/mpv/*.kt`.
- `videolan/vlc-android` GitHub mirror at 2026-10-29 ("Bump the remote access hash and version to 0.26.0"): every `res/xml/preferences*.xml`, `tools/.../Settings.kt`, `gui/video/*`, `gui/dialogs/*`, `resources/.../arrays.xml`, `strings.xml`.
- Maven Central metadata (fetched 2026-10-31) for `dev.ffmpegkit-maintained:*`, `dev.jdtech.mpv:libmpv`, `org.videolan.android:libvlc-all`, and the REX GitHub-Pages Maven repo.

Everything in sections 1 and 2 is from source unless marked "(knowledge)". Section 3 is design; command lines marked "verify" were not run here.

---

## 1. REX Player — exhaustive inventory

### 1.1 Stack and libmpv wiring

| Item | Value |
|---|---|
| App | `xyz.mpv.rex`, minSdk 26, targetSdk/compileSdk 36, Kotlin 2.4.10, AGP 9.3.1, Jetpack Compose (BOM 2026.02.01, Material3 1.5.0-alpha15), Navigation3, Koin 4.1.1, Room 2.8.4, kotlinx-serialization, OkHttp 5.3.2. Apache-2.0 app code. |
| libmpv artifact | `com.github.sfsakhawat999:mpvRex-libmpv:0.0.9` (alias `mpv-lib` in `libs.versions.toml`). Served from **`maven(url = "https://mpvrex.github.io/mpvRex-libmpv")`** (GitHub Pages Maven, published by `.github/workflows/release.yml` via `publishReleasePublicationToMavenRepository` + `peaceiris/actions-gh-pages`). Latest published: 0.0.9 (2026-09-05). AAR size: **78,316,238 bytes** (4 ABIs: armeabi-v7a, arm64-v8a, x86, x86_64; ABI splits in the app, `useLegacyPackaging = true`). Java package stays `is.xyz.mpv` (`MPVLib`, `BaseMPVView`, `MPVView`, `KeyMapping`, `Utils`, `FastClipper`, `FastThumbnails`, `MPVNode`). |
| Fork lineage | mpv-android → mpvEx (marlboro-advance) → mpvRex. Also credits mpvKt, NextPlayer, Gramophone. |
| Native build pins (`buildscripts/include/depinfo.sh`) | NDK r29 (29.0.14206865), SDK platform 35; lua 5.2.4, libunibreak 7.0, harfbuzz 14.2.1, fribidi 1.0.16, freetype 2.14.3, mbedtls 3.6.5; **FFmpeg pinned `n8.1.2` in CI**; **mpv, libass, libplacebo, dav1d are unpinned git master** (`download-deps.sh` clones `mpv-player/mpv`, `libass/libass`, `haasn/libplacebo`, `videolan/dav1d` HEAD). shaderc from the NDK. |
| mpv meson flags | `-Diconv=disabled -Dlua=enabled -Dvulkan=enabled -Dlibmpv=true -Dcplayer=false -Dmanpage-build=disabled`; shared libs; one custom patch `patches/mpv-shaders.patch` (makes `saturation`/`hue` work on RGB input, i.e. on MediaCodec hardware-decoded surfaces, by round-tripping through BT.709 YCbCr in `video/csputils.c`). A vulkan.pc stub for Vulkan 1.3.275 is written so `gpu-context=androidvk` builds. |
| FFmpeg configure (`scripts/ffmpeg.sh`) | `--enable-{jni,mediacodec,mbedtls,libdav1d} --disable-vulkan --enable-shared --enable-{gpl,version3}`; `--disable-{muxers,encoders,devices}` then **`--enable-encoder=mjpeg,png`** and **`--enable-muxer=mov,matroska,webm,mpegts,mp3,ogg,opus,flac,wav,adts,latm`** ("useful for clipping, remuxing, and dump-cache"). So this FFmpeg can remux but **cannot encode video/audio** (no libx264, no aac, no mediacodec encoders) and has **no libass in libavfilter** (libass is linked statically into mpv only). Confirms: mpv's own FFmpeg cannot be used for hardsub. |
| libass | `--enable-static --disable-shared --enable-libunibreak --disable-require-system-font-provider` (no fontconfig; fonts come from `sub-fonts-dir` and embedded attachments). |
| License consequence | mpv built GPL (meson default) + FFmpeg `--enable-gpl` ⇒ the AAR is GPL. Kurokawa is MIT; shipping this AAR in the main APK makes the combined work GPL. REX's own answer to this problem for yt-dlp is a separately installed companion APK (see 1.9). |
| JNI surface (`MPVLib.kt`) | `create(ctx)`, `init()`, `destroy()`, `attachSurface/detachSurface`, `command(vararg)`, `commandNode`, `setOptionString`, `get/setProperty{Int,Double,Boolean,String,Node}`, `observeProperty(name, format)`, event observer flows (`MPVLib.propInt/propDouble/propString` StateFlows), `grabThumbnail(dimension)`, `grabThumbnailFast(path, position, dimension, useHwDec)`, `grabAttachedPicture(path, dimension)`, `clearThumbnailCache()`, `cutClipNative(in, out, startSec, endSec, mode)`. `main.cpp` calls `av_jni_set_java_vm` + `av_jni_set_android_app_ctx` (needed for MediaCodec) and sets `msg-level=all=v,vo=debug` at create. |
| Other native/libs | `com.github.marlboro-advance:mediainfoAndroid:v1.0.0-fix` (MediaInfo for the Media Info screen), `io.github.yubyf:truetypeparser-light` (font names for the font picker), `com.hierynomus:smbj 0.14.0` (SMB2/3), `commons-net 3.12.0` (FTP), `com.github.thegrizzlylabs:sardine-android 0.8` (WebDAV), `org.nanohttpd:nanohttpd 2.3.1` (local range proxy + web share server), `com.github.abdallahmehiz:seeker 2.0.1` (seekbar), `me.zhanghai.compose.preference 2.1.1`, `androidx.media:media 1.7.1` (MediaSession), `androidx.security:security-crypto` (Jellyfin tokens), `K1rakishou:Fuck-Storage-Access-Framework 1.1.3`. |

Alternatives on Maven Central (for Kurokawa): `dev.jdtech.mpv:libmpv` 0.1.0 … **1.0.0** (2026-04-06; the Findroid library, Apache/LGPL-leaning build, `MPVLib` API-compatible subset, no FastClipper/thumbnails); `org.videolan.android:libvlc-all` 4.0.0-eap29 (2026-10-01).

### 1.2 libmpv initialisation order and every option set

`PlayerActivity.setupMPV()` → `MpvConfigSync.prepare()` (copies assets, syncs user config dir, rewrites `mpv.conf` hdr-toys block) → `BaseMPVView.initialize(filesDir, cacheDir)`:

1. `MPVLib.create(context)`
2. `config=yes`, `config-dir=<filesDir>`, `gpu-shader-cache-dir=<cacheDir>`, `icc-cache-dir=<cacheDir>`
3. `MPVView.initOptions()` (below)
4. `MPVLib.init()`
5. `postInitOptions()` (below), then `force-window=no`, `idle=once`; surface callbacks; `observeProperties()`.
6. Surface: `surfaceCreated` → `attachSurface`, `force-window=yes`, `vo=<voInUse>`; `surfaceChanged` → `android-surface-size=WxH` (plus REX's zero-distance `seek 0 relative+exact` repaint when paused); `surfaceDestroyed` → `vo=null`, `force-window=no`.

**`initOptions()` (`MPVView.kt`), in order:**

| Option | Value | Pref key / note |
|---|---|---|
| `profile` | `fast` default; choices `fast`, `default`, `high-quality`, `gpu-hq`, `low-latency`, `sw-fast` | `mpv_profile` |
| `vo` | `gpu-next` if `gpu_next` else `gpu` | `gpu_next` (default false) |
| `gpu-context` | `androidvk` only when `use_vulkan` | `use_vulkan` (default false) |
| `hwdec` | `mediacodec,no` if `try_hw_dec` else `no` (comment: `mediacodec-copy` omitted from the default chain because of Surface crashes) | `try_hw_dec` (default true) |
| `hwdec-codecs` | `all` | |
| `vf` | `format=yuv420p` only if `use_yuv420p` | `use_yuv420p` |
| `msg-level` | `all=v` if verbose else `all=warn` | `verbose_logging` |
| `keep-open` (property) | `yes` | |
| `input-default-bindings` (property) | `yes` | |
| `pause` (property) | `yes` if not autoplay-on-open | `autoplay_on_open` (default true) |
| `tls-verify` | `yes` | |
| `tls-ca-file` | `<filesDir>/cacert.pem` (copied from assets by `Utils.copyAssets`) | |
| `ytdl` | `no` (REX resolves streams itself via the companion app) | |
| `screenshot-directory` | `Environment.DIRECTORY_PICTURES` | |
| `brightness`, `saturation`, `contrast`, `gamma`, `hue` (−100..100), `sharpen` (−5..5) | from prefs | `filter_brightness` … `filter_sharpness` |
| `speed` | default speed | `default_speed` (1.0) |
| `vd-lavc-film-grain` | `cpu` | |
| `hr-seek` / `hr-seek-framedrop` | `yes`/`no` if precise seeking else `no`/`yes` | `use_precise_seeking` (default false); toggled live again in `PlayerViewModel` |
| Anime4K (only if enabled, mode ≠ OFF, and not (gpu-next without Vulkan)) | `opengl-pbo=yes`, `opengl-early-flush=no` (GL only), `vd-lavc-dr=yes`, `glsl-shaders=<chain>` | `enable_anime4k`, `anime4k_mode`, `anime4k_quality` |
| **Subtitles** (`setupSubtitlesOptions`) | `slang=""`, `sub-auto=no`, `sub-file-paths=""`, `subs-fallback=no` (app does its own autoload/selection), `sub-fonts-dir=<filesDir>/fonts/`, `sub-delay`, `sub-speed`, `secondary-sub-delay`, `secondary-sub-speed`, `sub-font` + `secondary-sub-font` (if set), `sub-ass-override=force` + `sub-ass-justify=yes` when "override ASS" else `sub-ass-override=no`, **`secondary-sub-ass-override=force`** always (so `secondary-sub-pos` anchors at top), `sub-font-size` (55), `sub-bold`, `sub-italic`, `sub-justify` (auto/left/center/right), `sub-color`, `sub-back-color`, `sub-border-color`, `sub-border-size` (3), `sub-border-style` (`outline-and-shadow`/`opaque-box`; `background-box` is used only transiently to highlight a grabbed subtitle), `sub-shadow-offset` (0), `sub-scale` (1.0), `sub-pos` (100), and the same `secondary-sub-*` set with `secondary-sub-scale`, `secondary-sub-pos` (10); `sub-scale-by-window`, `sub-use-margins`, `secondary-sub-scale-by-window`, `secondary-sub-use-margins` (all = `scaleByWindow`, default yes); `sub-vsfilter-bidi-compat` (= "force LTR" pref); `sub-codepage` (`auto` or chosen) | keys in 1.14 |
| **Audio** (`setupAudioOptions`) | `alang=""`, `audio-delay=<ms/1000>`, `audio-pitch-correction` (default yes), `volume-max=<100+boostCap>` (boost cap default 30 ⇒ 130), `af=dynaudnorm` if volume normalisation | `audio_delay_default`, `audio_pitch_correction`, `audio_volume_boost_cap`, `audio_volume_normalization` |

**`postInitOptions()`**: debanding `None` → nothing; `CPU` → `vf add @deband:gradfun=radius=12`; `GPU` → `deband=yes` (with `deband-iterations` 0..16, `deband-threshold` 0..200, `deband-range` 1..64, `deband-grain` 0..200 set as properties). If `enabled_stats_page` ≠ 0: `script-binding stats/display-stats-toggle` + `stats/display-page-N`.

**Set later at runtime (properties/commands):**

- Audio channels sheet: `audio-channels` = `auto-safe`/`auto`/`mono`/`stereo`; "reverse stereo" = `af=pan=[stereo|c0=c1|c1=c0]`.
- Decoder sheet: `hwdec` = `auto-copy`, `auto`, `no` (SW), `mediacodec-copy` (HW), `mediacodec` (HW+).
- Mirror/flip: `vf add @mpvex_hflip:hflip` / `@mpvex_vflip:vflip`; while any flip is active and `hwdec-current` is direct `mediacodec`, it switches `hwdec=mediacodec-copy` and restores afterwards (`VideoFlipFilterManager`).
- Aspect: `video-aspect-override=-1`+`panscan=0` (Fit), `panscan=1` (Crop), `video-aspect-override=<screen ratio>` (Stretch), `video-aspect-override=<ratio>` for presets `4:3, 16:9, 16:10, 21:9, 32:9, 2.35, 2.39` + user custom ratios (`custom_aspect_ratios`).
- Zoom/pan: `video-zoom` (−1..3, log scale, 0.01 steps), `video-pan-x/y`, `video-scale-x/y` (advanced zoom), defaults restored from prefs.
- Seeking: `seek <pos> absolute[+exact]`, `seek <delta> relative[+exact]`, `seek 100 absolute-percent+exact`, `seek 0 relative+keyframes`; `sub-seek 1|-1`; frame stepping `no-osd frame-step` / `no-osd frame-back-step`.
- Loop: `ab-loop-a`/`ab-loop-b` (`no` or seconds); `loop-file=inf|no`, `loop-playlist=no` (repeat ONE/ALL implemented app-side, mini player sets `loop-file`).
- Tracks: `sid`, `secondary-sid`, `aid` (`no` = off), `sub-add <url> select|auto [title] [lang]`, `sub-remove <id>`, `sub-reload [id]`, `audio-add <url> select|auto [title] [lang]`, `track-list/N/title` set after adding to label external tracks.
- OSD: `osd-level` 0/1 (`hide_osd_text_v2`); `script-binding stats/display-page-N`; `glsl-shaders` swapped live for Anime4K/hdr-toys; `load-script <file>` for user Lua and the generated custom-buttons script; `script-message call_button_<id>` / `call_button_long_<id>`.
- Streams: `user-agent`, `http-header-fields` (from intent `headers` or yt-dlp result), `force-media-title`, `loadfile <url> replace -1 "pause=yes|no,start=<sec>"`; DASH video+audio are joined as **`edl://!new_stream;!no_clip;!no_chapters;%<len>%<videoUrl>;!new_stream;!no_clip;!no_chapters;%<len>%<audioUrl>`**.
- Headless/mini player: `vo=null`, `idle=yes`, `force-window=no`; background audio: `vid=no` then restore `vid=<lastVid>`.
- Screenshots: `screenshot-to-file <tmp.png> subtitles|video` then copied into MediaStore `Pictures/`.
- Volume: `volume`, `volume-max`, `multiply volume <factor>`, `mute`, `cycle mute`.
- Observed properties (`observedProps`): `pause`, `paused-for-cache`, `seeking`, `core-idle`, `video-params/aspect|w|h`, `eof-reached`, `time-pos` (INT64 and DOUBLE), `duration`, `volume-max`, `track-list` (NODE), `chapter-list` (NODE), `speed`, `chapter`, `volume`, `hwdec-current`, `media-title`, `path`, `demuxer-cache-duration`, `cache-buffering-state`, `audio-delay`, `sub-delay`, `sub-speed`, `sub-scale`, `sub-pos`, `secondary-sub-scale`, `secondary-sub-pos`, `sub-bold`, `sub-italic`, `sub-justify`, `sub-font`, `sub-font-size`, `sub-border-style`, `sub-outline-size`, `sub-shadow-offset`, and the Lua↔app bridge `user-data/mpvex/{show_text,toggle_ui,show_panel,set_button_title,reset_button_title,toggle_button,seek_by,seek_to,seek_by_with_text,seek_to_with_text,software_keyboard}`.

**User mpv directory sync (`MpvConfigSync`)**: a SAF tree (`mpv_conf_storage_location_uri`) is scanned case-insensitively for `mpv.conf`, `input.conf`, `scripts/` (`.lua`, `.js`, only `selected_lua_scripts` when `enable_lua_scripts`), `script-opts/`, `shaders/` (`.glsl`, `.hook`, `.comp`, recursive), `fonts/` (`.ttf`, `.otf`, copied if absent), into `filesDir`. Without a directory, `mpv.conf`/`input.conf` come from the in-app editor prefs (`mpv.conf`, `input.conf` keys; `ConfigEditorScreen`). Every option above is set with `setOptionString` *before* `init`, so a user `mpv.conf` overrides them.

### 1.3 Playback

- Hardware decoding: `hwdec=mediacodec,no` default; switchable at runtime (sheet above); `hwdec-current` shown as a "DECODER" button (HW+/HW/SW).
- Renderers: `gpu` (GLES) default, optional `gpu-next`, optional Vulkan context (`androidvk`).
- Profiles: mpv built-ins (see table). Debanding CPU (gradfun) or GPU (deband) with 4 tunables.
- Colour filters: brightness/saturation/contrast/gamma/hue (−100..100) + sharpen (−5..5); 12 presets (`FilterPreset`: NONE, VIVID, WARM_TONE, COOL_TONE, SOFT_PASTEL, CINEMATIC, DRAMATIC, NIGHT_MODE, NOSTALGIC, GHIBLI_STYLE, NEON_POP, DEEP_BLACK with exact values in `PlayerEnums.kt`).
- **HDR → SDR tone mapping ("hdr-toys")**: shader pack bundled in `assets/shaders/hdr-toys/` (tone-mapping: `astra`, `bt2390`, `bt2446a`, `bt2446c`, `reinhard`, `linear`, `st2094-10`, `false`; gamut-mapping: `bottosson`, `clip`, `jedypod`, `false`; transfer functions pq/hlg/bt1886/srgb/bt709 + ~20 camera log curves; utils). Exposed choices: tone `ASTRA` (default), `BT2390`, `REINHARD`, `LINEAR`; gamut `BOTTOSSON` (default), `CLIP`, `JEDYPOD`. Applied by writing a **conditional profile into `mpv.conf`** between markers:
  ```
  [bt.2100-pq]
  profile-cond=get("video-params/primaries") == "bt.2020" and get("video-params/gamma") == "pq"
  profile-restore=copy
  target-prim=bt.2020
  target-trc=pq
  glsl-shader=<dir>/utils/clip_both.glsl
  glsl-shader=<dir>/transfer-function/pq_inv.glsl
  glsl-shader=<dir>/tone-mapping/<tone>.glsl
  glsl-shader=<dir>/gamut-mapping/<gamut>.glsl
  glsl-shader=<dir>/transfer-function/bt1886.glsl
  ```
  (i.e. the display is told it is PQ/BT.2020 so mpv does no tone mapping of its own, and the shaders do PQ→linear→tone map→gamut map→BT.1886.) `MoreSheet` can also swap the chain live via `glsl-shaders`. Keys: `enable_hdrtoys`, `hdrtoys_tone_mapping`, `hdrtoys_gamut_mapping`.
- **Anime4K**: 14 GLSL shaders bundled (Clamp_Highlights, Restore_CNN_{S,M,L}, Restore_CNN_Soft_{S,M,L}, Upscale_CNN_x2_{S,M,L}, Upscale_Denoise_CNN_x2_{S,M,L}, AutoDownscalePre_x2). Modes A, B, C, A+A, B+B, C+A (chains in `Anime4KManager.getShaderChain`), quality FAST=S / BALANCED=M / HIGH=L. Not available for high-resolution sources (`anime4k_not_available_high_res`). Requires `gpu` or `gpu-next`+Vulkan.
- Audio passthrough: **none** (no `audio-spdif`/`ao` options anywhere). Audio output is mpv's default AudioTrack AO.
- Speed: `speed` property; presets default `0.25…4.0` (12 values, `default_speed_presets`), cycle presets `1.0,1.25,1.5,1.75,2.0` (`speed_cycle_presets`), ±0.05 stepper clamped 0.05..4.0, pitch-correction toggle in the sheet; default speed pref; long-press speed (`hold_for_multiple_speed` 2×) with memory mode Global / PerVideo (SHA-256-keyed pref `long_press_speed_video_<hash>`) / Reset; "speed-adjusted remaining time" display.
- Frame stepping: Frame Navigation sheet (`frame-step`/`frame-back-step`, frame counter `FrameInfo(current,total)`, snapshot of the current frame with/without subtitles).
- Zoom/pan: pinch-to-zoom (log-scale, 1.2 gain), two-finger pan while pinching, single-finger pan when zoomed (needs `pan_and_zoom_enabled`, 20 px threshold), "advanced zoom" = independent `video-scale-x/y`, Video Zoom sheet with ±0.01 steps, per-video zoom persisted in `PlaybackStateEntity.videoZoom`, default zoom/pan/scale prefs.
- Aspect: Fit/Crop/Stretch (`VideoAspect`) + ratio presets + custom; default aspect pref, `remember_video_aspect`, per-video `videoAspect`/`customAspectRatio` persisted (the last commit of the repo is exactly about this).
- Rotation: `PlayerOrientation` = Free, Video (auto from `video-params/aspect` & `rotate`), Smart (remembers per video `savedOrientation`), Portrait, ReversePortrait, SensorPortrait, Landscape, ReverseLandscape, SensorLandscape; rotation button cycles temporarily.
- Mirror / vertical flip buttons (see 1.2).
- Resume: `save_position`, `resume_playback_mode` Always/Ask/Never, `auto_resume_on_ask`, resume prompt dialog; positions saved per `mediaTitle` with `timeRemaining`, `hasBeenWatched`, speed, zoom, sid, secondary sid, aid, sub/audio delay, sub speed, external subtitle/audio URIs, orientation, aspect.
- Autoplay next (`autoplay_next_video`), `close_after_eof`, `keep_screen_on_when_paused`, `autoplay_on_open`.
- Repeat OFF/ONE/ALL + shuffle; custom skip button (`custom_skip_duration` default 90 s, Custom Skip sheet).
- Loading indicator (`show_loading_circle`), cache state from `paused-for-cache`/`cache-buffering-state`/`demuxer-cache-duration`, seekbar read-ahead (`show_seekbar_read_ahead`).

### 1.4 Gestures (all in `GestureHandler.kt`, `TapChromeEngine.kt`, `SubtitleTouch.kt`, `SubtitleGestureEngine.kt`)

| Gesture | Action | Config |
|---|---|---|
| Single tap | toggle controls; a tap waits out the double-tap window unless `instant_controls_toggle` | `instant_controls_toggle` |
| Double tap left / centre / right | `SingleActionGesture`: None, Seek (±`double_tap_to_seek_duration`, default 10 s, multi-tap accumulates), SubSeek (`sub-seek`), PlayPause, Custom (sends `keypress MBTN_LEFT_DBL` / `MBTN_MID_DBL` / `MBTN_RIGHT_DBL` so `input.conf` can bind), PlaylistNext, PlaylistPrev. Defaults: left Seek, centre PlayPause, right Seek. | `left_double_tap_gesture`, `center_drag_gesture`, `right_drag_gesture`, `double_tap_seek_area_width` (35 %), `reverse_double_tap`, `double_tap_chapter_to_skip` (double tap jumps chapters instead), `use_single_tap_for_center`, `use_single_tap_for_left_right`, `show_double_tap_ovals`, `show_circular_double_tap_seek` |
| Vertical swipe left half | brightness (window attribute; `remember_brightness`, `default_brightness`); swapped with `display_volume_on_right` | `gestures_brightness`, `swap` |
| Vertical swipe right half | volume: system volume up to max, then **mpv `volume` boost** up to `volume-max` (100+`audio_volume_boost_cap`); display as percentage option | `volume_brightness`, `audio_volume_boost_cap`, `display_volume_as_percentage` |
| Horizontal swipe (outside top/bottom 25 % exclusion zones) | scrub seek, sensitivity `horizontal_swipe_sensitivity` (0.05 s/px default), live time + delta overlay, optional seekbar shown while seeking, relative vs absolute mode, "release to cancel" | `horizontal_swipe_to_seek`, `use_relative_seeking`, `enable_release_to_cancel`, `show_seek_time_while_seeking`, `show_seekbar_when_seeking` |
| Horizontal swipe in the top/bottom 25 % | subtitle seek: right → previous subtitle, left → next (`sub-seek`), 50 px threshold | `swipe_to_subtitle_seek` |
| Long press (≈ hold) | temporary speed (`hold_for_multiple_speed`), ramped in steps to avoid audio-filter stutter; while holding: horizontal drag changes the speed through the presets (`SpeedControlSlider`), **swipe up locks the speed** ("speed lock", hint after 2 s), swipe down unlocks | `hold_for_multiple_speed`, `long_press_speed_memory_mode`, `show_dynamic_speed_overlay`, `show_speed_indicator_overlay`, hint counters |
| Pinch (2 fingers) | zoom (`video-zoom`), simultaneous pan | `pinch_to_zoom_gesture` |
| Single-finger drag when zoomed | pan | `pan_and_zoom_enabled` |
| Touch on a rendered subtitle | drag to reposition (`sub-pos` / `secondary-sub-pos`, integer %), pinch to resize (`sub-scale`), highlighted with a temporary `background-box` style; works for bitmap subs with an estimated hit box; persisted to prefs | `move_subtitle_by_dragging`, `pinch_to_resize_subtitle` |
| 3-finger / multi-finger | cancels seek/tap; no screenshot gesture (VLC has one) | |
| Seekbar | tap-to-seek can be disabled; chapter markers; wavy/thick/circular/simple styles | `prevent_seekbar_tap`, `show_seekbar_chapters`, `seekbar_style`, `use_wavy_seekbar`, `white_seekbar` |
| Lock | lock button hides all; "slide to unlock" (`SlideToUnlock`) | |
| Gestures inside panels | allowed or not | `allow_gestures_in_panels` |
| Edge exclusion | system gesture insets excluded for volume/brightness | |
| Hardware keys (`PlayerKeyEventHandler`, `MPVView.onKey`) | D-pad up shows controls, left/right seek, centre/enter/space play-pause, volume keys, media keys (stop, rewind, FF, play/pause/next/previous) mapped via `media_*_gesture` prefs (PlaylistPrev/PlayPause/PlaylistNext by default; can be Custom → `keypress PREV/PLAYPAUSE/NEXT`); any other key is translated with `KeyMapping` into `keydown`/`keyup` with `shift/ctrl/alt/meta` modifiers so `input.conf` works; `disable_media_buttons` |

### 1.5 Subtitles

- Formats: whatever libass/FFmpeg demux (ASS/SSA, SRT, WebVTT, VobSub idx/sub, PGS sup, DVB, mov_text…). Autoload scans the video's folder for files whose name starts with the video base name and whose extension is in a large set: `srt vtt ass ssa sub idx sup xml ttml dfxp itt ebu imsc usf sbv srv1 srv2 srv3 json sami smi mpl pjs stl rt psb cap scc vttx lrc krc txt pgs`. First match gets `select` unless `sub_disable_by_default`; network videos try `<base>.{srt,ass,ssa,vtt,sub}` over the proxy or list the remote folder. Also a `sub_custom_folder` and `sub_picker_path`, file picker opening at the video location.
- Encoding: `sub-codepage` auto or one of 19 codepages (`SubtitleEncodingUtils.ENCODINGS`: utf-8, windows-1256, iso-8859-6, 1250/8859-2, 1251/8859-5, koi8-r, 1252/8859-1, 1253/8859-7, 1255/8859-8, 1254/8859-9, gb18030, big5, …); external files are normalised to UTF-8 copies in cache before `sub-add` (`normalizeLocalSubtitleFile`), and a per-track re-encode/reload path exists (`sub-reload`, `sub-remove`+`sub-add`).
- Styling panel (live properties, all persisted): font (from `sub_fonts_folder` + imported fonts, listed with truetypeparser; "Default"/"Reset" forces a libass renderer rebuild by re-writing `sub-fonts-dir` with an equivalent spelling — see `SubtitleFontRefresh.kt`), size, bold, italic, justify (auto/left/center/right + `sub-ass-justify`), text/border/background colours, border size, border style, shadow offset, scale, position, secondary position/scale, `sub-ass-override` toggle ("override ASS"), scale-by-window, force LTR (`sub-vsfilter-bidi-compat`), codepage.
- Secondary subtitles: `secondary-sid`, promoted/demoted from the track sheet, always `secondary-sub-ass-override=force` and `secondary-sub-pos` (top, 10). Saved per video.
- Delay/speed panel: `sub-delay` (ms steps, default pref `sub_default_delay`), `sub-speed` (`sub_default_speed`), with "default" reset; saved per video.
- Fonts: `sub-fonts-dir=<filesDir>/fonts/`. Sources: (a) user font folder (`sub_fonts_folder`) copied in, (b) imported single fonts (SAF, manifest `.imported_fonts`, max per-file/batch sizes, SFNT signature check, dedup by content), (c) `fonts/` from the mpv config dir. **Embedded MKV attachments are handled by libass itself** (mpv passes attachments to libass; nothing in the app touches them). There is no "load fonts from the video's directory" feature — only the user-chosen folder.
- Online search: two providers — **Wyzie** (`https://sub.wyzie.io`, TMDB-based title search with season/episode, sources/formats/encodings/HI filters, API key optional) and **SubDL** (`subdl_api_key`, `subdl_languages`); downloads saved to `sub_save_folder`, then `sub-add`. (No OpenSubtitles.)
- Intent extras: `subs` (Parcelable `Uri[]`) + `subs.enable` (subset to select); each is added with `sub-add <uri> select|auto`. No `subs.name` extra.
- Snapshot with subtitles (`include_subtitles_in_snapshot`).

### 1.6 Audio

Tracks sheet (`aid`, external `audio-add` from picker `audio_picker_path`, labels/lang set on `track-list/N/title`), preferred languages (`audio_preferred_languages`, applied by `TrackSelector` since `alang` is blanked), channel layout (auto-safe/auto/mono/stereo/reverse-stereo), delay panel (`audio-delay`, default pref), pitch correction, volume boost cap, `dynaudnorm` normalisation, **background playback**: `BackgroundPlaybackMode` Always/AudioOnly/VideoOnly/Never + `automatic_background_playback`; a foreground `MediaPlaybackService` (`FOREGROUND_SERVICE_MEDIA_PLAYBACK`) with MediaSession actions PLAY/PAUSE/PLAY_PAUSE/STOP/SEEK_TO/SKIP_NEXT/SKIP_PREVIOUS/SET_REPEAT_MODE/SET_SHUFFLE_MODE/TOGGLE_*, `AUDIO_BECOMING_NOISY`, audio focus (`PlayerAudioController`); `vid=no` while in background to save battery. Headless "mini player" bar in the browser (`HeadlessPlaybackController`, `play_in_mini_player_directly`) drives the same global mpv instance with `vo=null`. Audio files show album art by selecting the attached-picture track (`vid=<albumart id>`). No equalizer.

### 1.7 Chapters, bookmarks

`chapter-list` NODE observed; Chapters sheet; `chapter` property to jump; current-chapter button; seekbar chapter markers; double-tap-to-skip-chapter option. **Bookmarks** (`BookmarkEntity`: mediaKey, positionMs, title, createdAt; min gap between pins) with add/rename/delete, shown in the Bookmarks/Chapters sheet and on the seekbar.

### 1.8 Playlists, library, browsing, Shorts

- Tabs (`bottom_nav_order` default `home,shorts,recents,playlists,network,you`; each toggleable: `enable_tab_you/recents/playlists/network`, `enable_shorts`) — the "dynamic tabs".
- Home views (`folder_view_mode`): AlbumView (folders), FileManager (tree), MediaLibrary (flat, hybrid SAF+MediaStore index with `library_scan_roots`, `HybridMediaEntity`). List/grid (`media_layout_mode`), grid columns per orientation, sort by title/duration/date/size/count with per-type order memory, hidden files, `.nomedia` inclusion, audio files toggle, blacklisted folders, search (`SearchScreen`, fuzzy), per-card chips (size, resolution, fps, date, total duration/size/count, extension, subtitle indicator, progress bar, thumbnails via `grabThumbnailFast` at first frame or `thumbnail_position_percent`), "NEW" badge for unplayed files younger than `unplayed_old_video_days`, watched dimming at `watched_threshold` 95 %, last-played highlight + `auto_scroll_to_last_played`, mark as new/finished/last-played (`MarkAsState`), multi-select (select all/invert/range) with delete (with file deletion), rename, share, copy/move/paste (`CopyPasteOps`), add to playlist, media info sheet (MediaInfo lib) and a share-target `MediaInfoActivity` (`enable_media_info_activity`).
- Recents (`RecentlyPlayedEntity`, `enable_recently_played`, `auto_remove_deleted_from_history`, `exclude_external_playback_from_history`, `played_network_links`), You tab (profile name/image, recents, playlists, shorts, network shortcuts).
- Playlists (`PlaylistEntity`/`PlaylistItemEntity`): create/rename/delete, reorder (reorderable), auto playlists "Recently added" and "Most played" (`MediaPlayCountEntity`), M3U/M3U8 import (`M3UParser`, EXTINF/tvg-logo), folder playlists (`FolderPlaylistOps`), in-player Playlist sheet (list/grid), `playlist_mode` (auto-generate a playlist from the folder when opening a file), repeat/shuffle.
- **Shorts**: vertical pager of short/vertical videos (`ShortsMediaEntity`, source folders, include horizontal videos ≤ N minutes, auto-swipe, loop-file inf, glass controls, blocked list, "loved" elastic ordering).

### 1.9 Streaming

- Open URL / Play Link sheet; schemes in manifest: `content file http https rtmp rtmps rtp rtsp mms mmst mmsh tcp udp smb` + explicit `youtu.be`, `*youtube.com`, `*twitch.tv` hosts and `.mkv/.mp4/.webm/.avi/.mov` path patterns.
- Network tab: saved connections (`NetworkConnection`: SMB 445, FTP 21, WebDAV 80/443 with `useHttps`, anonymous, auto-connect). Files are served to mpv through a local **NanoHTTPD range proxy** (`NetworkStreamingProxy`, `smb://`/`ftp://` → `http://127.0.0.1:<port>/…`, HTTP 206). Optional network thumbnails. No UPnP/DLNA, SFTP, NFS.
- **yt-dlp**: the app sets `ytdl=no` and binds an AIDL service in a separately installed companion **"REX Ytdlp"** (`xyz.mpv.rex.addon.ytdl`, action `xyz.mpv.rex.addon.ytdl.BIND_SERVICE`, permission `xyz.mpv.rex.permission.BIND_YTDL_ADDON`, signature-verified with `checkSignatures`). AIDL: `getAddonVersion`, `isReady`, `getStatus`, `runInstall`, `runUpdate(nightly)`, `resolveStream(url, options)`, `extractPlaylist(url, options)`; results include video/audio URLs, DASH flag, alternate audio tracks (v2), title, duration, thumbnail, uploader, HTTP headers, subtitles map, and a quality list. Prefs: `ytdl_quality` (auto/2160…144/audio_only with the exact `bestvideo[height<=N][vcodec^=avc1]+bestaudio[acodec^=mp4a]/…` format strings in `YtdlPreferences.buildExtractionOptions`), `ytdl_custom_format`, `ytdl_custom_user_agent`, `ytdl_proxy`, `ytdl_cookies_file`, `ytdl_geo_bypass`, `ytdl_prefer_nightly`, `ytdl_auto_detect_web_pages`, `ytdl_custom_domains`. In-player **Video Quality sheet** reloads with `loadfile … "pause=…,start=<pos>"`.
- **Jellyfin**: settings screen (server URL, user, password → `/Users/AuthenticateByName`, encrypted prefs, device id/name), acts as an *external player* for the Jellyfin app (detects `/Videos/…/stream` URLs + `position` extra, reports `/Sessions/Playing`, `/Sessions/Playing/Progress`, `/Sessions/Playing/Stopped`, marks played/unplayed, returns `position`/`duration` in the result intent), and an optional **remote-control session** (`enable_remote`): WebSocket session advertising `SupportedCommands: Play, PlayState, PlayNext, SetVolume, SetAudioStreamIndex, SetSubtitleStreamIndex`, handling `Playstate` (pause/unpause/seek/stop) and `GeneralCommand` (volume, mute).

### 1.10 PiP, background, sleep timer, media session

PiP (`supportsPictureInPicture`, `MPVPipHelper`): aspect from `video-params`, source rect, remote actions play/pause/±10 s (`seek ±10 <mode>`), `auto_pip_on_navigation`, `pip_on_home`, brightness restore. Background playback and MediaSession as in 1.6 (Android Auto/Wear/Bluetooth via `MediaSessionCompat`). Sleep timer sheet: presets 15/30/45/60/90/120 min, slider 5..180 in 5-min steps (no "end of video" option). System bars toggles (`show_system_status_bar`, `show_system_navigation_bar`), `player_time_to_disappear` (4000 ms), `reduce_motion`, gradient opacity.

### 1.11 A-B loop and clip export (already in REX)

- A-B loop button: sets `ab-loop-a`/`ab-loop-b` to the current position, clears both.
- "Cut Clip" from the A-B loop UI → `ClipExportSheet` with two modes (`FastClipper.ClipMode`):
  - **FAST_COPY** — "Instant stream copy with 100 % original quality. Starts at nearest keyframe." Native `clipper.cpp` mode 0: `avformat_seek_file(…, AVSEEK_FLAG_BACKWARD)` to the keyframe ≤ A, copies video/audio/subtitle packets (`avcodec_parameters_copy`) until B, `av_interleaved_write_frame`. Output extension follows the input (`mkv`, `webm`, `ts`, `mov`, else `mp4`; `flv`/`avi` → `mkv`).
  - **FRAME_ACCURATE** — "Frame-accurate export starting on the exact timestamp." Mode 1: software decode with libavcodec → `sws_scale` to NV12 → **`AMediaCodec` `video/avc` encoder** (bitrate = source bitrate or `w*h*fps*0.12` clamped 2.5–20 Mbit/s, I-frame interval 1 s, color format 21) and `audio/mp4a-latm` AAC-LC encoder → **`AMediaMuxer` MP4**. Always `.mp4`, suffix `_exact`. No subtitles are burned; subtitle streams are dropped in this mode.
  - Fallbacks in `VideoClipper.kt`: mpv `dump-cache <A> <B> <file>` for MKV in fast mode (only if the range is cached), then Android `MediaExtractor`+`MediaMuxer` copy (MP4/WebM).
  - Output: `Movies/REX Player/<name>_clip_<A>s-<B>s[_exact][_n].<ext>`, then `MediaScannerConnection`.

### 1.12 Screenshots and frame navigation

`screenshot-to-file <tmp> subtitles|video` → `Pictures/` via MediaStore (PNG, `mpv_snapshot_<ts>.png`), toast; from the Frame Navigation sheet or a custom button; `include_subtitles_in_snapshot`. Ambient mode (`ambient_enabled`): `PixelCopy` of the surface, average edge colours → glow overlay (not an mpv feature).

### 1.13 UI, theming, dynamic tabs, custom buttons

- Material You, AMOLED, dark modes, app themes, `player_always_dark_mode`, `match_player_controls_to_theme`, system font, bounce animation, **glass controls** (`enable_glass_player_controls`, `enable_glass_seekbar_background`, `enable_glass_shorts_controls` — `GlassModifier.kt` blur/translucency), hide button backgrounds, gradient opacity, seekbar styles (Standard/Wavy/Thick/Circular/Simple).
- **Control layout editor**: six slots as CSV of `PlayerButton` names — `top_left_controls` (BACK_ARROW,VIDEO_TITLE fixed), `top_right_controls` (VIDEO_QUALITY,CURRENT_CHAPTER,DECODER,AUDIO_TRACK,SUBTITLES,MORE_OPTIONS), `bottom_right_controls` (PICTURE_IN_PICTURE,ASPECT_RATIO), `bottom_left_controls` (LOCK_CONTROLS,BACKGROUND_PLAYBACK,SCREEN_ROTATION,PLAYBACK_SPEED,REPEAT_MODE,SHUFFLE,AB_LOOP), `portrait_bottom_controls`, `more_sheet_controls`. Available buttons: BOOKMARKS_CHAPTERS, PLAYBACK_SPEED, DECODER, SCREEN_ROTATION, FRAME_NAVIGATION, VIDEO_ZOOM, PICTURE_IN_PICTURE, ASPECT_RATIO, LOCK_CONTROLS, AUDIO_TRACK, SUBTITLES, MORE_OPTIONS, CURRENT_CHAPTER, REPEAT_MODE, SHUFFLE, MIRROR, VERTICAL_FLIP, AB_LOOP, CUSTOM_SKIP, BACKGROUND_PLAYBACK, AMBIENT_MODE, SLEEP_TIMER, VIDEO_QUALITY. `playback_controls_position` Center/Bottom/Hide; `bottom_controls_below_seekbar`; `show_next_previous_buttons`.
- **Custom Lua buttons**: up to 8 slots (`custom_buttons_json`, `CustomButton{title, content, longPressContent, onStartup}`); the app generates one Lua script registering `call_button_<id>` / `call_button_long_<id>` script-messages and `mp.set_property_native('user-data/mpvex/custombuttons_loaded','1')`; scripts can talk back through the `user-data/mpvex/*` properties listed in 1.2 (show text, toggle UI, open panel, retitle a button, seek).
- Sheets: PlaybackSpeed, SubtitleTracks, OnlineSubtitleSearch, AudioTracks, Chapters, Decoders, More (tabs: Settings / Interaction / Gestures / Controls / Aesthetics + stats page + Anime4K), VideoZoom, AspectRatios, Playlist, FrameNavigation, CustomSkipDuration, SleepTimer, ClipExport, VideoQuality. Panels: SubtitleSettings, SubtitleDelay, AudioDelay, VideoFilters.
- Settings search (`SettingsSearchScreen`, fuzzy), onboarding/welcome, crash screen, in-app update checker (`api.github.com/repos/mpvRex/REX-Player/releases/latest`), codec information screen, Lua script editor, config editor, translation via Droidlate.

### 1.14 Complete preference key list (by class)

- **DecoderPreferences**: `mpv_profile`(fast) `try_hw_dec`(true) `gpu_next`(false) `use_vulkan`(false) `use_yuv420p`(false) `debanding`(None) `deband_iterations`(1) `deband_threshold`(48) `deband_range`(16) `deband_grain`(32) `filter_brightness` `filter_saturation` `filter_gamma` `filter_contrast` `filter_hue` `filter_sharpness` `enable_anime4k`(false) `anime4k_mode`(OFF) `anime4k_quality`(FAST) `enable_hdrtoys`(false) `hdrtoys_tone_mapping`(ASTRA) `hdrtoys_gamut_mapping`(BOTTOSSON)
- **PlayerPreferences**: `player_orientation`(Video) `background_playback_mode`(AudioOnly) `invert_duration` `speed_adjusted_remaining_time` `hold_for_multiple_speed`(2f) `long_press_speed_memory_mode`(Reset) `long_press_speed_video_<sha256>` `show_dynamic_speed_overlay`(t) `show_speed_indicator_overlay`(t) `show_double_tap_ovals`(t) `show_circular_double_tap_seek`(t) `show_seek_time_while_seeking`(t) `use_precise_seeking`(f) `gestures_brightness`(t) `volume_brightness`(t) `pinch_to_zoom_gesture`(t) `horizontal_swipe_to_seek`(t) `swipe_to_subtitle_seek`(t) `move_subtitle_by_dragging`(t) `pinch_to_resize_subtitle`(t) `horizontal_swipe_sensitivity`(0.05) `custom_aspect_ratios` `default_speed`(1) `default_speed_presets` `speed_cycle_presets` `display_volume_as_percentage`(t) `display_volume_on_right` `show_loading_circle`(t) `save_position`(t) `resume_playback_mode`(Always) `auto_resume_on_ask`(t) `close_after_eof`(t) `remember_brightness` `default_brightness`(-1) `allow_gestures_in_panels` `show_system_status_bar` `show_system_navigation_bar` `reduce_motion`(t) `player_gradient_opacity`(1) `player_time_to_disappear`(4000) `default_video_zoom`(0) `default_video_pan_x/y`(0) `pan_and_zoom_enabled`(f) `advanced_zoom_enabled`(f) `default_video_scale_x/y`(1) `include_subtitles_in_snapshot`(f) `playlist_mode`(t) `playlist_view_mode_list`(t) `play_in_mini_player_directly`(f) `use_wavy_seekbar`(t) `bottom_controls_below_seekbar`(f) `playback_controls_position`(Center) `show_seekbar_when_seeking`(f) `white_seekbar`(f) `show_seekbar_chapters`(t) `show_seekbar_read_ahead`(t) `hide_osd_text_v2`(f) `custom_skip_duration`(90) `repeat_mode`(OFF) `shuffle_enabled`(f) `autoplay_next_video`(t) `autoplay_on_open`(t) `show_controls_on_play`(f) `auto_pip_on_navigation`(f) `pip_on_home`(f) `keep_screen_on_when_paused`(f) `default_video_aspect`(Fit) `default_custom_aspect_ratio`(-1) `remember_video_aspect`(f) `custom_buttons_json`("[]") `ambient_enabled`(f) `disable_media_buttons`(f) `last_more_sheet_tab`
- **GesturePreferences**: `double_tap_to_seek_duration`(10) `double_tap_seek_area_width`(35) `left_double_tap_gesture`(Seek) `center_drag_gesture`(PlayPause) `right_drag_gesture`(Seek) `use_single_tap_for_center`(f) `prevent_seekbar_tap`(f) `use_relative_seeking`(t) `enable_release_to_cancel`(t) `use_single_tap_for_left_right`(f) `reverse_double_tap`(f) `instant_controls_toggle`(f) `double_tap_chapter_to_skip`(f) `media_previous_gesture`(PlaylistPrev) `media_play_gesture`(PlayPause) `media_next_gesture`(PlaylistNext) `tap_thumbnail_to_select`(f) + hint counters `speed_lock_hint_shown_count` `has_locked_speed_before` `subtitle_pos_hint_shown_count` `has_dragged_subtitle_before`
- **SubtitlesPreferences**: `sub_preferred_languages` `sub_disable_by_default`(f) `sub_autoload_enabled`(t) `sub_fonts_folder` `sub_font`("") `sub_font_size`(55) `sub_scale`(1) `sub_border_size`(3) `sub_bold`(f) `sub_italic`(f) `sub_color_text`(white) `sub_color_border`(black) `sub_border_style`(OutlineAndShadow) `sub_shadow_offset`(0) `sub_color_bg`(transparent) `sub_justify`(Auto) `sub_pos`(100) `secondary_sub_pos`(10) `secondary_sub_scale`(1) `sub_override_ass` `sub_scale_by_window`(t) `sub_force_ltr`(f) `sub_encoding`(auto) `sub_default_delay` `sub_default_speed`(1) `sub_picker_path` `sub_font_picker_path` `sub_custom_folder` `sub_open_at_video_location`(f) `subdl_api_key` `sub_save_folder` `subdl_languages`(en) `wyzie_sources`(all) `wyzie_formats`(srt,ass) `wyzie_encodings`(utf-8) `wyzie_hi`(f) `wyzie_api_key`
- **AudioPreferences**: `audio_preferred_languages` `audio_delay_default` `audio_pitch_correction`(t) `audio_channels`(AutoSafe) `audio_volume_boost_cap`(30) `automatic_background_playback`(f) `audio_volume_normalization`(f) `audio_picker_path` `audio_open_at_video_location`(t)
- **AdvancedPreferences**: `mpv_conf_storage_location_uri` `mpv.conf` `input.conf` `verbose_logging` `enabled_stats_page`(0) `enable_recently_played`(t) `auto_remove_deleted_from_history`(f) `exclude_external_playback_from_history`(f) `enable_media_info_activity`(f) `enable_lua_scripts`(f) `selected_lua_scripts`
- **AppearancePreferences**: `dark_mode`(System) `app_theme`(Default) `app_language` `onboarding_completed` `material_you`(t) `amoled_mode`(f) `match_player_controls_to_theme`(f) `use_system_font`(f) `unlimited_name_lines`(f) `hide_player_buttons_background`(f) `show_next_previous_buttons`(t) `enable_glass_player_controls`(f) `enable_glass_seekbar_background`(f) `enable_bounce_animation`(f) `show_community_icon` … `show_hidden_files`(f) `custom_profile_name` `custom_profile_image_path` `show_unplayed_old_video_label`(t) `unplayed_old_video_days`(7) `show_network_thumbnails`(f) `seekbar_style`(Standard) `player_always_dark_mode`(t) `hide_play_fab_show_in_header`(f) `thumbnail_strategy`(FirstFrame) `thumbnail_position_percent`(30) `top_left_controls` `top_right_controls` `bottom_right_controls` `bottom_left_controls` `portrait_bottom_controls` `more_sheet_controls`
- **BrowserPreferences**: `folder_sort_type`/`folder_sort_order` (+ per-type `folder_sort_order_{title,duration,date,size,count}`), `video_sort_type`/`video_sort_order` (+ per-type), `network_sort_type`/`network_sort_order`/`network_show_hidden_files` (+ per-type), `folder_view_mode`(AlbumView) `sort_dialog_filters_expanded` `folder_grid_columns_portrait/landscape` `video_grid_columns_portrait/landscape` `show_video_thumbnails`(t) `show_file_extension`(f) `show_size_chip`(t) `show_resolution_chip`(f) `show_framerate_in_resolution`(f) `show_subtitle_indicator`(f) `show_progress_bar`(t) `media_layout_mode`(LIST) `show_total_videos_chip`(t) `show_total_duration_chip`(f) `show_total_size_chip`(t) `show_date_chip`(f) `show_folder_path`(t) `auto_scroll_to_last_played`(f) `watched_threshold`(95) `show_audio_files`(f) `include_no_media_content`(f) `show_tree_view_path`(f) `enable_shorts`(t) `shorts_auto_swipe`(f) `enable_glass_shorts_controls`(f) `show_shorts_back_button`(t) `shorts_include_horizontal`(f) `shorts_max_horizontal_minutes`(1) `shorts_source_folders` `shorts_last_watched_path` `enable_tab_you/recents/playlists/network`(t) `bottom_nav_order` `played_network_links` `show_recently_added_playlist`(t) `show_most_played_playlist`(t)
- **FoldersPreferences**: `blacklisted_folders` `library_scan_roots`
- **YtdlPreferences**: listed in 1.9. **JellyfinPreferences** (encrypted): server URL, user id, access token, device id; plain: `enable_remote`, device name, username.

### 1.15 Intents (open-with, share, results)

- `ACTION_VIEW` with the schemes/MIME types in 1.9 (`video/*`, `audio/*`, `*/rmvb`, `*/avi`, `*/mkv`, `application/{3gpp*,mp4,mpeg*,ogg,sdp,vnd.3gp*,vnd.apple.mpegurl,vnd.dvd*,vnd.dolby*,vnd.rn-realmedia*,x-extension-mp4,x-flac,x-matroska,x-mpegurl,x-ogg,x-quicktimeplayer}`), `ACTION_SEND` (`video/*`, `audio/*`, `image/*`, `text/plain` — a shared URL text is parsed), `ACTION_SEND_MULTIPLE`.
- Extras honoured (mpv-android/MX-style): `position` (ms), `subs`, `subs.enable`, `title`/`filename`, `headers` (string array of key/value pairs; `User-Agent` becomes `user-agent`, the rest `http-header-fields`), `uri`, `playlist` (URI list) + `playlist_titles`, `playlist_id`/`playlist_index`, `network_file_path`/`network_connection_id`, `saved_orientation`, `width`/`height`/`rotation`, `internal_launch`, `launch_source`. Result intent action `xyz.mpv.rex.ui.player.PlayerActivity.result` with `position` and `duration` (ms) for callers (Jellyfin uses this).
- Launcher alias keeps the old `app.marlboroadvance.mpvex.MainActivity` component.

### 1.16 Nearby sharing ("Share with nearby devices")

`feature/webshare`: a NanoHTTPD server (`WebShareServer`) with an HTML page, QR code (`QrCodeGenerator`) of `http://<lan-ip>:<port>`, `/download/<id>` with HTTP 206 range support, `/download-all` as a streamed ZIP, `/upload` (POST, saved to `Downloads/REX Player`), run from a foreground `WebShareService` (`FOREGROUND_SERVICE_DATA_SYNC`). No mDNS/discovery; it is "scan the QR from the other phone's browser".

---

## 2. VLC for Android — what users expect

From the `vlc-android` source (prefs XML, `Settings.kt`, `VideoPlayerActivity` delegates) plus general VLC knowledge where marked. libvlc 4.0.0-eap29 on Maven; app GPLv2+, libvlc LGPLv2.

### 2.1 Engine
Every format/codec/protocol libvlc has; hardware decoding `hardware_acceleration` = −1 Automatic / 0 Disabled / 1 Decoding (MediaCodec, copy) / 2 Full (direct rendering); dev option OMX/OMX-DR; `opengl` auto/on/off; `aout` AudioTrack(0)/OpenSL ES(2); `audio_digital_output` (passthrough of AC-3/E-AC-3/TrueHD/DTS over HDMI/SPDIF — also offered for casting `casting_passthrough`); `enable_time_stretching_audio`; `deblocking` (auto/always/nonref/nonkey/all); `enable_frame_skip`; `dav1d_thread_number`; `network_caching` (ms); `prefer_smbv1`; `http_user_agent`; `custom_libvlc_options`; `video_match_frame_rate` (display refresh matching); `preferred_resolution` for adaptive streams (best/1080/720/…); HDR with tonemapping (libvlc README). 360° video (FOV 20..150 via pinch) and Ambisonics.

### 2.2 Video player
- Gestures (`VideoTouchDelegate`, bitmask `TOUCH_FLAG_*`): volume (right half), brightness (left half), swipe seek (horizontal, with `always_fast_seek`), double-tap seek (`video_double_tap_jump_delay`), double-tap centre play/pause (`enable_double_tap_play`), scale/pinch (`enable_scale_gesture`, cycles scale types), **tap-and-hold fast play** (`enable_fastplay`, `fastplay_speed`), **3-finger screenshot** (`screenshot_mode` 0 disabled / 1 button / 2 gesture / 3 both), overlay toggle by tap, lock button with `lock_use_sensor`, PIN "lock with PIN" (parental/`safe_mode`), `save_brightness`, `audio_boost` (volume to 200 %), seek buttons `enable_seek_buttons` + `video_jump_delay`/`video_long_jump_delay`, HUD timeout `video_hud_timeout_in_s`, `video_transition_show`, `show_remaining_time`, `display_under_notch`.
- Aspect (`MediaPlayer.ScaleType`): BEST_FIT, FIT_SCREEN, FILL, 16:9, 4:3, 16:10, 2:1, 2.21:1, 2.35:1, 2.39:1, 5:4, ORIGINAL; remembered in `video_ratio`.
- Orientation `screen_orientation`; `lock_orientation`; `show_orientation_button`.
- Advanced options sheet (IDs in `gui/dialogs`): **A-B repeat** (`ID_ABREPEAT`, with fast-seek warning), audio/subtitle delay (`VideoDelayDelegate`, `audio_delay_global`, `save_individual_audio_delay`), **bookmarks** (`ID_BOOKMARK`, named, markers on the seekbar `audio_show_bookmark_markers`), chapter picker (`ID_CHAPTER_TITLE`, `SelectChapterDialog`), **equalizer** (`ID_EQUALIZER`, presets + custom, save/copy/export), **jump to time** (`ID_JUMP_TO`), lock player, passthrough toggle, playback speed dialog (0.25–8×, per-media or global `playback_speed_video_global`), **play as audio** / play as video, **popup (floating) video** (`ID_POPUP_VIDEO`, `PopupManager`, `custom_popup_height`, `popup_keepscreen`, `popup_force_legacy`), repeat/shuffle, safe-mode lock, save playlist, share, **sleep timer** (`ID_SLEEP`, `sleep_timer_wait` "wait for media end", `sleep_timer_reset_interaction`, `default_sleep_timer`), video stats (`ID_VIDEO_STATS`), video/audio control settings.
- Tracks dialog (`VideoTracksDialog`): audio/subtitle/video tracks, "load external subtitle", **subtitle download** (`SubtitleDownloaderDialogFragment` → OpenSubtitles REST v1 via `OpenSubtitleRepository`: search by **movie hash** (`FileUtils.computeHash`, the OpenSubtitles 64-bit hash) then by name/season/episode, languages, hearing-impaired, user login + daily limit).
- Resume: `video_resume_playback`, `video_confirm_resume` (ask/always/never), `VideoResumeTime/Uri`, `media_seen` badge, `playback_history`.
- Picture-in-Picture (`video_action_switch` 0 stop / 1 background audio / 2 PiP when leaving the app), `restore_background_video`, `enable_clone_mode` for secondary displays (Presentation API).
- Screenshots (`VideoPlayerScreenshotDelegate`), on-screen tips (`VideoTipsDelegate`), benchmark mode, Android TV UI (`tv_ui`), hinge/foldable layouts (`allow_fold_auto_layout`, `hinge_on_right`).

### 2.3 Subtitles (prefs)
Presets (`subtitles_presets` 0..5: default, large, largest, white background, yellow, yellow background), `subtitles_autoload`, `subtitle_text_encoding`, `subtitle_preferred_language`, size, bold, colour + opacity, background (+colour/opacity), shadow (+colour/opacity), outline (+size/colour/opacity). libvlc renders through libass (`freetype` module); user fonts from the VLC fonts directory; embedded attachments supported. Only one subtitle track at a time.

### 2.4 Audio player
Full music library (artists/albums/tracks/genres/playlists), lockscreen cover, blurred cover background, queue, `audio_force_shuffle`, `audio_stop_after`, gapless/`resume_playback`, headset detection (`enable_headset_detection`, `enable_play_on_headset_insertion`, `ignore_headset_media_button_presses`), ReplayGain (`audio-replay-gain-mode/preamp/default/peak-protection`), audio ducking, SoundFont for MIDI, chapter/bookmark buttons in the audio player, Android Auto with queue formatting and speed/seek buttons, widgets (`preferences_widgets.xml`), notification seek bar, `audio_task_removed` (stop when swiped away), `audio_jump_delay`.

### 2.5 Library and browsing
Medialibrary module (video/audio scan, `directories`, `auto_rescan`, `include_missing`, `browser_show_hidden_files`, `browser_show_only_multimedia`, cards/list, groups and folders, `video_min_group_length`, `quick_play`), history, **incognito mode** (`incognito_mode`, `persistent_incognito`), parental control (`safe_mode`, `restrict_settings`, PIN), metered-connection behaviour, permissions page, export/restore settings, dump/clear DB.

### 2.6 Network
Browser for **SMB (v1 option), FTP, FTPS, SFTP, NFS, UPnP/DLNA servers**, saved servers (`NetworkServerDialog`), login dialog with keystore-encrypted password (`store_login`), streams via "Open network stream", **casting** to Chromecast and UPnP renderers (`enable_casting`, `casting_audio_only`, `casting_passthrough`, `casting_quality` high/medium/low/lowcpu), **Remote Access** web UI (`enable_remote_access`: file browser, network browser, history, playback control, logs, served over LAN), extensions API (`preferences_extension_page.xml`).

### 2.7 Misc
Themes (`app_theme` system/light/black, `enable_black_theme`), locale, `list_title_ellipsize`, `show_headers`, nightly update channel, verbose/debug logs, what's-new, Android TV, widgets.

---

## 3. A/B cut with optional hardsub — design

### 3.1 UX
Reuse the A-B loop UI: two markers on the seekbar (also typed times), live loop preview, then **Export**:
- Mode: *Fast (keyframe, lossless)* / *Exact (re-encode)*; "Burn subtitles" checkbox (forces Exact). Show the effective start when Fast snaps to a keyframe (query it: `ffprobe -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -read_intervals <A-30>%<A> -of csv` and pick the last pts ≤ A; or on Android `MediaExtractor.seekTo(SEEK_TO_PREVIOUS_SYNC)` and read `sampleTime`).
- Burn options: which track (default = the active `sid`), apply current style overrides (font/size/colour/position if `sub-ass-override` is on), include secondary track, resolution (source / 1080 / 720), codec (H.264 / HEVC), quality slider (CRF or bitrate), keep audio track(s) (copy when the container allows, else AAC).
- Output: `Movies/Kurokawa/<name>_<A>-<B>[_sub].mkv|mp4`; MKV for Fast when the source is MKV (keeps ASS + attachments), MP4 otherwise.

### 3.2 Fast cut — stream copy

```
ffmpeg -y -ss <A> -to <B> -i in.mkv -map 0 -c copy -avoid_negative_ts make_zero out.mkv
```
- `-ss` **before** `-i` seeks the demuxer to the keyframe ≤ A; with `-c copy` nothing can be dropped, so the clip starts up to one GOP early (REX's "starts at nearest keyframe"). Use `-t <B-A>` on old ffmpeg builds where input `-to` is not accepted.
- `-ss` **after** `-i` with `-c copy` instead keeps the timestamps and drops packets before A; the first video packet is then usually a non-keyframe → black/garbled start until the next keyframe (do not offer this).
- MP4 target: subtitle streams must be `-c:s mov_text` (text only, styles lost) and attachments cannot be mapped (`-map -0:t`); ASS/VobSub/PGS only survive in MKV. MKV keeps fonts (`-map 0` includes `t` streams).
- Container by input: mkv→mkv, mp4/mov→mp4 (`-movflags +faststart`), webm→webm, ts→ts or mkv; avi/flv/wmv→mkv.
- Negative timestamps: `-avoid_negative_ts make_zero` so MP4 does not start with an edit list offset.
- "Smart cut" (re-encode only the first partial GOP and concat) is possible but not worth it in v1.

### 3.3 Exact cut with hardsub — re-encode

Recommended two-step flow, because it is deterministic and lets the app control the subtitle file (style overrides, delay, secondary track):

**Step 0 — inspect**
```
ffprobe -v error -show_entries stream=index,codec_type,codec_name:stream_tags=language,title,filename,mimetype -of json in.mkv
```
Attachment streams have `codec_type: attachment` and tags `filename`/`mimetype` (`font/ttf`, `font/otf`, `application/x-truetype-font`, `application/vnd.ms-opentype`, `application/x-font-ttf`, `font/sfnt`, `font/collection`).

**Step 1 — dump embedded fonts** into a per-job `fontsdir/` (no `chdir` is needed when each target path is given explicitly, which matters for in-process ffmpeg-kit):
```
ffmpeg -y -dump_attachment:t:0 fontsdir/<filename0> -dump_attachment:t:1 fontsdir/<filename1> … -i in.mkv
```
(`-dump_attachment:t ""` dumps every attachment under its own `filename` tag into the current directory — fine on desktop, not in-process on Android.) Also copy the user's REX-style font folder and the font chosen in the player (`sub-font`) into `fontsdir/` so `force_style`/overrides resolve. libass loads every file in `fontsdir` (ttf/otf/ttc), and still falls back to fontconfig/system fonts when a face is missing.

**Step 2 — extract the chosen subtitle track**, rebased to the clip start:
```
ffmpeg -y -ss <A> -to <B> -i in.mkv -map 0:s:<n> -c:s ass cut.ass          # text subs (ASS/SSA/SRT/VTT → ASS)
```
Input-side `-ss` rebases all timestamps to 0 at A, so `cut.ass` starts at 0. Caveat: an event that *starts* before A but is still on screen at A may be dropped by the seek; to be safe extract the whole track (`-map 0:s:n -c copy full.ass`, or `-c:s ass` for non-ASS) and let the app shift times by −A (plus the player's `sub-delay`), dropping events ending ≤ 0 and clamping starts to 0 — ASS `Dialogue:` lines are trivial to rewrite, and the `[Script Info]`/`[V4+ Styles]` header is preserved verbatim. External subtitles (the file the user loaded) go through the same shift. Style overrides from the player (when `sub-ass-override=force`) are applied by rewriting the `Default`/all styles in `[V4+ Styles]` (Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Outline, Shadow, Alignment, MarginV from `sub-pos`), or with `force_style=` below.

**Step 3 — render**
```
ffmpeg -y -ss <A> -to <B> -i in.mkv \
  -vf "subtitles=cut.ass:fontsdir=fontsdir[:force_style='FontName=Noto Naskh Arabic,FontSize=28'][:original_size=1920x1080],format=yuv420p" \
  -map 0:v:0 -map 0:a:<m> -c:v libx264 -preset medium -crf 18 -c:a copy -movflags +faststart out.mp4
```
- Prefer the `subtitles=` filter over `ass=`: both use libass and accept `fontsdir`, but `subtitles` also decodes SRT/VTT/mov_text through libavcodec, offers `force_style`, `original_size`, `si=<index>` (to point at the MKV directly: `subtitles=in.mkv:si=<n>` — only valid without input `-ss`, because the filter reads the file from 0 while the frames are rebased; that is the reason for step 2), `charenc`, `stream_index`. `ass=` only reads ASS files and has no `force_style`.
- Filter-graph escaping: in `-vf`, escape `\ : ' [ ] , ;` in paths (`C\:\\Users\\…` on Windows); or pass the graph from a file (`-/vf graph.txt`, ffmpeg ≥ 7.0) / `-filter_script:v`. Android paths without special characters avoid the problem; put the job in `cacheDir/clip-<id>/` with ASCII names.
- Audio: `-c:a copy` when the output container accepts the codec (MP4: AAC/AC-3/E-AC-3/MP3/Opus(experimental)/ALAC; otherwise `-c:a aac -b:a 192k`); use MKV output to keep anything (FLAC, DTS, TrueHD, Vorbis).
- Exactness: input `-ss` + default `-accurate_seek` decodes from the preceding keyframe and drops frames until A, so the first output frame is the frame at/after A. If the output must start on a keyframe at exactly A, that is already true (first encoded frame is an IDR).
- Bitmap subtitles (PGS/VobSub/DVB): no `subtitles` filter; overlay the decoded bitmap stream:
  `-filter_complex "[0:v][0:s:<n>]overlay=shortest=1[v]" -map "[v]"` (with `-ss` before `-i` both streams rebase together; `scale2ref` if the sub canvas differs).
- Secondary track burned too: chain two `subtitles=` filters (`subtitles=primary.ass:…,subtitles=secondary.ass:…`), with the secondary's `Alignment=8`/MarginV rewritten to the top like REX's `secondary-sub-pos=10`.
- Scaling: put `scale=-2:1080` **before** `subtitles` so libass renders at the output size (sharper), or after for faithful positions of ASS with `original_size`.
- HDR sources: burning into 8-bit H.264 needs tone mapping — `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p` before `subtitles`; or keep HDR with `-c:v libx265 -pix_fmt yuv420p10le -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -x265-params repeat-headers=1:hdr-opt=1` (desktop only; Android HEVC HW encoders accept 10-bit but ffmpeg's `hevc_mediacodec` cannot carry mastering metadata — verify).
- Progress: `-progress pipe:1 -nostats` (desktop) or ffmpeg-kit statistics callback (`time`, `size`, `speed`).

**Single-pass alternative (no temp .ass) — verify before relying on it:**
```
ffmpeg -ss <A> -copyts -i in.mkv -ss <A> -to <B> \
  -vf "subtitles=in.mkv:si=<n>:fontsdir=fontsdir,setpts=PTS-STARTPTS" -af asetpts=PTS-STARTPTS \
  -c:v libx264 -crf 18 -c:a aac out.mp4
```
`-copyts` keeps original timestamps so the filter picks the right lines; the second `-ss` drops frames before A (ffmpeg inserts `trim`/`atrim` ahead of user filters); `setpts` re-zeroes the output. It needs the whole MKV readable by the filter and, with large negative/positive offsets, has bitten people in MP4 edit lists; hence the two-step as the default.

### 3.4 Which ffmpeg on Android

- **Not mpv's.** The REX libmpv FFmpeg is configured `--disable-encoders --disable-muxers` except mjpeg/png and a few muxers, and libavfilter has no libass (1.1). `dev.jdtech.mpv:libmpv` is built the same way (knowledge). mpv's `dump-cache` only copies what is in the demuxer cache and only to MKV.
- **arthenica/ffmpeg-kit is retired** (announced 2024; binaries < 6.0 removed by 2025-02-01, 6.0 by 2025-04-01; GitHub repo archived). Do not depend on `com.arthenica:*`.
- **Use `dev.ffmpegkit-maintained`** (community continuation, Maven Central, verified 2026-10-31): latest **8.1.9** (2026-09-25, FFmpeg n8.1.3, NDK r27c, arm64-v8a + x86_64, 16 KB page-size aligned, minSdk 24, compileSdk 35). Artifacts: `dev.ffmpegkit-maintained:ffmpeg:8.1.9` (recommended "free" tier, ≈23.5 MB AAR with both ABIs, ≈11.4 MB arm64-only), and tiered `ffmpeg-kit-min`, `ffmpeg-kit-min-gpl`, `ffmpeg-kit-https`, `ffmpeg-kit-https-gpl`, `ffmpeg-kit-audio`, `ffmpeg-kit-video`, `ffmpeg-kit-full`, `ffmpeg-kit-full-gpl` (all 8.1.9). LTS lines 7.1.7 / 6.0.4 exist. Same `FFmpegKit.executeAsync()`, `FFprobeKit`, `FFmpegKitConfig.setFontDirectory(context, dir, mapping)` API as the original (knowledge of the fork's README).
  - `subtitles`/`ass` filters need **libass** → `-full` or `-full-gpl` (or the `:ffmpeg` free tier if it lists libass — check the release notes for the tier you pick; the page names libass only in the `-full` names).
  - Licensing: `-gpl` adds x264/x265/xvid and makes the APK GPLv3; the non-GPL `full` is LGPLv3 (fine with MIT if dynamically linked and notices shipped). Without x264, encode with **`-c:v h264_mediacodec`** (FFmpeg ≥ 6.0 has MediaCodec *encoders*: `h264_mediacodec`, `hevc_mediacodec`; options `-bitrate_mode cbr|vbr|cq`, `-b:v`, `-g`, `-level`, `-pix_fmt nv12`; needs `--enable-mediacodec --enable-jni`, which ffmpeg-kit builds have) and `-c:a aac` (native encoder). Quality ≈ REX's AMediaCodec path; `libx264 -crf` is only available in the GPL tier.
  - Size budget: ≈ 11–25 MB (free tier) up to ≈ 30–40 MB for `full-gpl` with two ABIs (estimate; measure). Ship it in the **player add-on APK** (Kurokawa already plans "the full player comes as the player add-on"), not in the MIT core — the same trick REX uses for yt-dlp, and it keeps the GPL libmpv AAR out of the core too.
  - Alternatives: build FFmpeg yourself with the mpv-android `buildscripts` plus `--enable-libass --enable-encoder=h264_mediacodec,hevc_mediacodec,aac --enable-muxer=mp4,matroska` and expose a JNI `ffmpeg_main()`; or extend REX's `clipper.cpp` approach (libavcodec decode → libass render → `AMediaCodec` encode → `AMediaMuxer`), which avoids ffmpeg-kit entirely but needs a libass that exports symbols (REX's is static inside libmpv).
  - `content://` inputs: pass `/proc/self/fd/<fd>` from `openFileDescriptor` (REX does this) or ffmpeg-kit's `saf:` protocol (`FFmpegKitConfig.getSafParameterForRead(context, uri)`); outputs via `getSafParameterForWrite` or write to `cacheDir` then copy into MediaStore `Movies/`.
- **Desktop (Electron)**: spawn a system or bundled `ffmpeg` (`ffmpeg-static` npm wraps GPL static builds: BtbN on Windows/Linux, evermeet on macOS — GPL distribution notice needed; or let the user point to their own binary). `fluent-ffmpeg` is unmaintained; use `child_process.spawn` with `-progress pipe:1`. Fonts: desktop fontconfig finds system fonts; still pass `fontsdir` with the dumped attachments.

### 3.5 Edge cases to handle
Variable frame rate sources (keep `-vsync passthrough`/`-fps_mode passthrough` for copy; for encode `-fps_mode cfr` if the MediaCodec encoder stutters), rotated videos (`-noautorotate` to keep the rotation tag with copy; the `subtitles` filter renders in coded orientation — rotate first with `transpose` when autorotate is on), multiple audio tracks (`-map 0:a` all for MKV), chapter ranges (`-map_chapters -1` to drop or let ffmpeg trim), attachments larger than ~50 MB (font packs), ASS with `PlayResX/Y` ≠ video size (libass scales; `original_size` not needed for ASS), `sub-codepage` for legacy SRT (`charenc=cp1256`), and B > duration / A ≥ B validation.

---

## 4. What to take for Kurokawa Tools (ranked)

1. **libmpv init recipe (1.2) verbatim** — profile/`vo=gpu`/`hwdec=mediacodec,no`/`hwdec-codecs=all`/`keep-open`/`tls-ca-file`/`sub-fonts-dir`/blank `alang`,`slang`,`sub-auto=no` with app-side track selection, `edl://` for separate DASH video+audio, `loadfile … "pause=…,start=…"` options, `secondary-sub-ass-override=force` + `secondary-sub-pos=10`, the observed-property list, `vo=null`/`force-window` surface lifecycle. Prefer `dev.jdtech.mpv:libmpv:1.0.0` (Maven Central, no GitHub-Pages repo, LGPL-friendlier) unless we need REX's `FastClipper`/`grabThumbnailFast`; keep the mpv-android patch for saturation/hue on RGB surfaces in mind.
2. **A-B loop → Cut Clip** with Fast/Exact modes (REX already validates the UX), extended with the hardsub checkbox from §3; ffmpeg via `dev.ffmpegkit-maintained` in the player add-on APK, `h264_mediacodec` by default.
3. **Subtitle system**: autoload by base name with the broad extension set, codepage list (Arabic first for our users), `sub-fonts-dir` + imported fonts + font-renderer-rebuild trick, secondary subtitles, drag-to-position / pinch-to-resize, delay+speed panel, per-video persisted sub state, "override ASS" toggle. Add VLC-style presets (default/large/yellow/background) as quick styles, and OpenSubtitles hash search (VLC) alongside Wyzie/SubDL.
4. **Gesture engine**: REX's full set (double-tap zones with chapter option, swipe seek with exclusion zones and release-to-cancel, subtitle-seek swipe, long-press speed with slider + swipe-up lock, pinch zoom + pan, brightness/volume with mpv boost) plus VLC's 3-finger screenshot and tap-and-hold fast play as toggles.
5. **Persisted per-video state** (`PlaybackStateEntity` fields) and the media-state matrix (New / Never played / Watched / Last played), resume Always/Ask/Never, watched threshold.
6. **HDR → SDR**: ship hdr-toys shaders with the conditional `[bt.2100-pq]` profile (works on `gpu`), expose tone (astra/bt2390/reinhard/linear) and gamut (bottosson/clip/jedypod); on desktop prefer mpv's built-in `tone-mapping` with `gpu-next`.
7. **Background audio + MediaSession + PiP** with the `vid=no` trick and headless `vo=null` mini-player; sleep timer (add VLC's "wait for end of media").
8. **Video filters/presets, deband, Anime4K** as optional "Enhancements" (cheap to port: just option/property writes + bundled GLSL).
9. **Control-layout editor + custom Lua buttons + `user-data/<app>/*` bridge + user mpv dir sync** — high value for power users, low cost.
10. **Network**: SMB/FTP/WebDAV through a local range proxy (REX) is simpler than libvlc's native access modules; add UPnP/SFTP later if asked. Jellyfin external-player protocol and result intent are small and worth copying. yt-dlp as a companion/add-on process with the AIDL-like interface.
11. **VLC items worth adding that REX lacks**: equalizer (mpv `af=equalizer`/`superequalizer`), audio passthrough (`audio-spdif=ac3,eac3,dts-hd,truehd` + `audio-exclusive`), jump-to-time dialog, popup/floating player (PiP covers it on Android), Chromecast (not feasible with libmpv; would need a transcoding sender — out of scope), incognito/parental PIN, remote-access web UI (REX's web share is a subset).
12. **Skip**: Shorts mode, glass theming, ambient glow, community prompts — product-specific polish, not player value.
