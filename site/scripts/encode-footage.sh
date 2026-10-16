#!/usr/bin/env bash
# Turn the raw recordings from record-footage.mjs into the website's media, following the scroll-craft skill:
# desktop clips get a dense keyframe interval so they scrub (seeking walks from the previous keyframe), phone clips are
# short muted loops cut from the 390px recordings, audio is stripped everywhere, and every poster is the clip's own
# first frame so nothing jumps when the video paints.
#
#   node site/scripts/record-footage.mjs && bash site/scripts/encode-footage.sh
#
# Needs a full ffmpeg build (libx264, libwebp). Writes to site/public/media/ (committed).
set -euo pipefail
cd "$(dirname "$0")"
SRC=.footage
OUT=../public/media
mkdir -p "$OUT" "$SRC/tmp"

ff() { ffmpeg -y -hide_banner -loglevel error "$@"; }

# scrub encode: dense GOP (8), crf 22, no audio, faststart. Same settings as the skill's encode.sh desktop mode, at
# the clip's own size instead of a forced 1080p, because these are UI crops, not full frames.
scrub() { ff -i "$1" -an -vf "format=yuv420p" -c:v libx264 -profile:v high -preset slow -crf "${3:-22}" -g 8 -keyint_min 8 -sc_threshold 0 -movflags +faststart "$2"; }
# phone loop: ordinary GOP is fine for playback, crf 26, no audio
loop() { ff -i "$1" -an -vf "format=yuv420p" -c:v libx264 -profile:v high -preset slow -crf "${3:-26}" -g 60 -movflags +faststart "$2"; }
poster() { ff -i "$1" -frames:v 1 -c:v libwebp -quality "${3:-80}" "$2"; }
lastframe() { ff -sseof -0.05 -i "$1" -frames:v 1 -c:v libwebp -quality "${3:-80}" "$2"; }

# 1. Paste: onboarding reads a website. Desktop crop of the centre column (1.5x recording), 0-15.5 s.
ff -i "$SRC/onboard.mp4" -t 15.5 -vf "crop=1020:840:570:120,scale=850:-2:flags=lanczos" -c:v libx264 -crf 12 -an "$SRC/tmp/paste.mp4"
scrub "$SRC/tmp/paste.mp4" "$OUT/paste.mp4"
poster "$OUT/paste.mp4" "$OUT/paste-poster.webp"
lastframe "$OUT/paste.mp4" "$OUT/paste-end.webp"
# phone: the 390px recording, top of the screen (above the tab bar), 0-12.5 s
ff -i "$SRC/onboard-phone.mp4" -t 12.5 -vf "crop=780:1300:0:70,scale=480:-2:flags=lanczos" -c:v libx264 -crf 12 -an "$SRC/tmp/paste-phone.mp4"
loop "$SRC/tmp/paste-phone.mp4" "$OUT/paste-phone.mp4"
poster "$OUT/paste-phone.mp4" "$OUT/paste-phone-poster.webp"

# 2. The office: the floor only (no side panel), 0-14 s.
ff -i "$SRC/office.mp4" -vf "crop=1512:650:48:218" -c:v libx264 -crf 12 -an "$SRC/tmp/office.mp4"
scrub "$SRC/tmp/office.mp4" "$OUT/office.mp4" 21
poster "$OUT/office.mp4" "$OUT/office-poster.webp" 82
# phone: the office on a 390px screen, below the page title, 0-14 s
ff -i "$SRC/office-phone.mp4" -vf "crop=780:1300:0:220,scale=480:-2:flags=lanczos" -c:v libx264 -crf 12 -an "$SRC/tmp/office-phone.mp4"
loop "$SRC/tmp/office-phone.mp4" "$OUT/office-phone.mp4"
poster "$OUT/office-phone.mp4" "$OUT/office-phone-poster.webp"

# 3. Ask: the answer column, the team's steps (0-4 s) then the answer arriving (22-31.5 s). The path opens after
# 31.5 s and is shown as a still instead (see the stills below).
ff -i "$SRC/ask.mp4" -filter_complex "[0:v]trim=0:4,setpts=PTS-STARTPTS[a];[0:v]trim=22:31.5,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1,crop=1080:1266:735:84,scale=720:-2:flags=lanczos" -c:v libx264 -crf 12 -an "$SRC/tmp/ask.mp4"
scrub "$SRC/tmp/ask.mp4" "$OUT/ask.mp4"
poster "$OUT/ask.mp4" "$OUT/ask-poster.webp"
lastframe "$OUT/ask.mp4" "$OUT/ask-end.webp"

ls -la "$OUT"
du -sh "$OUT"
