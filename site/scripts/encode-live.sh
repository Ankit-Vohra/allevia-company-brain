#!/usr/bin/env bash
# Turn the real run recorded by record-live.mjs into the home page's office footage, the way the scroll-craft skill asks:
#   - the scrub clip gets a keyframe every 12 frames (a second), because seeking walks from the previous keyframe;
#   - the phone loop is an ordinary encode, played muted only while it is on screen;
#   - no audio anywhere.
# The office floor and the work line under it are cropped out of the 1440x900 recording (nothing else of the page).
#
#   node site/scripts/record-live.mjs hero && bash site/scripts/encode-live.sh
#
# Needs a full ffmpeg build (libx264, libwebp). Writes site/public/media/ (committed).
set -euo pipefail
cd "$(dirname "$0")"
SRC=.footage-live
OUT=../public/media
mkdir -p "$OUT" "$SRC/tmp"
ff() { ffmpeg -y -hide_banner -loglevel error "$@"; }

# Office floor plus the one-line status under it: x 32..1040, y 144..630 of the page. 12 frames a second is plenty for a
# floor where people walk a pixel or two a frame, and halves the file.
CROP="fps=12,crop=1008:486:32:144,scale=760:-2:flags=lanczos,format=yuv420p"
END="${HERO_SECONDS:-100}"
ff -i "$SRC/hero.webm" -t "$END" -an -vf "$CROP" -c:v libx264 -profile:v high -preset slow -crf 31 -g 12 -keyint_min 12 -sc_threshold 0 -movflags +faststart "$OUT/ask-office.mp4"
ff -ss "${BUSY_AT:-30}" -i "$SRC/hero.webm" -frames:v 1 -vf "crop=1008:486:32:144,scale=760:-2:flags=lanczos" -c:v libwebp -quality 82 "$OUT/ask-office-busy.webp"

# The phone and hero loop: the busiest 14 seconds of the same run, smaller.
ff -ss "${LOOP_AT:-17}" -i "$SRC/hero.webm" -t 14 -an -vf "fps=12,crop=1008:486:32:144,scale=640:-2:flags=lanczos,format=yuv420p" -c:v libx264 -profile:v high -preset slow -crf 29 -g 48 -movflags +faststart "$OUT/office-loop.mp4"
ff -ss "${LOOP_AT:-17}" -i "$SRC/hero.webm" -frames:v 1 -vf "crop=1008:486:32:144,scale=640:-2:flags=lanczos" -c:v libwebp -quality 80 "$OUT/office-loop-poster.webp"
ls -la "$OUT"/ask-office* "$OUT"/office-loop*
