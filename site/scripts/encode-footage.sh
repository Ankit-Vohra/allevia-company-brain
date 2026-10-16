#!/usr/bin/env bash
# Turn the recordings from record-footage.mjs, and the team's real work in docs/creative-live/v2, into the website's
# media, the way the scroll-craft skill asks:
#   - a scrub clip gets a keyframe every 8 frames, because seeking walks from the previous keyframe (an ordinary web
#     encode plays fine and scrubs like mud);
#   - a phone loop is an ordinary encode, played muted only while it is on screen;
#   - every poster is the clip's own first frame, so nothing jumps when the video paints;
#   - no audio anywhere.
#
#   (cd web && npm run build) && node site/scripts/record-footage.mjs && bash site/scripts/encode-footage.sh
#
# Needs a full ffmpeg build (libx264, libwebp). Writes site/public/media/ (committed).
set -euo pipefail
cd "$(dirname "$0")"
SRC=.footage
CL=../../docs/creative-live/v2
OUT=../public/media
mkdir -p "$OUT" "$SRC/tmp"

ff() { ffmpeg -y -hide_banner -loglevel error "$@"; }
master() { ff -ss "${SKIP:-0}" -i "$1" "${@:3}" -c:v libx264 -crf 12 -preset medium -an "$2"; }
scrub() { ff -i "$1" -an -vf "format=yuv420p" -c:v libx264 -profile:v high -preset slow -crf "${3:-22}" -g 8 -keyint_min 8 -sc_threshold 0 -movflags +faststart "$2"; }
loop() { ff -i "$1" -an -vf "format=yuv420p" -c:v libx264 -profile:v high -preset slow -crf "${3:-27}" -g 60 -movflags +faststart "$2"; }
webp() { ff -i "$1" "${@:4}" -frames:v 1 -c:v libwebp -quality "$3" "$2"; }
first() { webp "$1" "$2" "${3:-80}"; }

# ---- the office, mid-request (the hero). Desktop: the floor only, 2160x1350 recording at 1.5x. ----
master "$SRC/office.mp4" "$SRC/tmp/office.mp4" -vf "crop=1530:880:40:200,scale=1440:-2:flags=lanczos"
scrub "$SRC/tmp/office.mp4" "$OUT/office.mp4" 27
first "$OUT/office.mp4" "$OUT/office-poster.webp" 82
# phone: the 390px recording (2x), from the floor's top edge, above the tab bar
SKIP=1 master "$SRC/office-phone.mp4" "$SRC/tmp/office-phone.mp4" -vf "crop=780:1220:0:300,scale=520:-2:flags=lanczos"
loop "$SRC/tmp/office-phone.mp4" "$OUT/office-phone.mp4"
first "$OUT/office-phone.mp4" "$OUT/office-phone-poster.webp"

# ---- paste your website: onboarding reads a site (centre column). ----
SKIP=0.8 master "$SRC/onboard.mp4" "$SRC/tmp/paste.mp4" -vf "crop=1080:1060:540:96,scale=760:-2:flags=lanczos"
loop "$SRC/tmp/paste.mp4" "$OUT/paste.mp4" 26
first "$OUT/paste.mp4" "$OUT/paste-poster.webp"
SKIP=0.8 master "$SRC/onboard-phone.mp4" "$SRC/tmp/paste-phone.mp4" -vf "crop=780:1300:0:84,scale=480:-2:flags=lanczos"
loop "$SRC/tmp/paste-phone.mp4" "$OUT/paste-phone.mp4"
first "$OUT/paste-phone.mp4" "$OUT/paste-phone-poster.webp"

# ---- one request, all the way: the team's steps (0-22 s, played 4x) then the answer arriving (22-26.6 s). ----
ff -i "$SRC/ask.mp4" -filter_complex "[0:v]trim=0.8:22,setpts=(PTS-STARTPTS)/4[a];[0:v]trim=22:26.6,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1,crop=1080:1200:735:150,scale=760:-2:flags=lanczos[v]" -map "[v]" -c:v libx264 -crf 12 -an "$SRC/tmp/ask.mp4"
scrub "$SRC/tmp/ask.mp4" "$OUT/ask.mp4" 22
first "$OUT/ask.mp4" "$OUT/ask-poster.webp"
ff -sseof -0.05 -i "$OUT/ask.mp4" -frames:v 1 -c:v libwebp -quality 82 "$OUT/ask-end.webp"
# "How we know" open: the founder's first name is blurred where the sample graph shows it (a label and a chip).
ff -ss 39.5 -i "$SRC/ask.mp4" -frames:v 1 -filter_complex "[0:v]split=3[base][l][c];[l]crop=150:40:1932:512,boxblur=8[lb];[c]crop=116:40:1478:1142,boxblur=8[cb];[base][lb]overlay=1932:512[t];[t][cb]overlay=1478:1142,crop=1755:1266:405:84,scale=1400:-2:flags=lanczos" -c:v libwebp -quality 82 "$OUT/path.webp"

# ---- stills (2160x1350 at 1.5x) ----
webp "$SRC/approve-before.png" "$OUT/ok-before.webp" 84 -vf "crop=900:640:630:390,scale=720:-2:flags=lanczos"
webp "$SRC/approve-after.png" "$OUT/ok-after.webp" 84 -vf "crop=900:640:630:390,scale=720:-2:flags=lanczos"
webp "$SRC/approve-after.png" "$OUT/fix-card.webp" 84 -vf "crop=900:500:630:390,scale=640:-2:flags=lanczos"
webp "$SRC/insights.png" "$OUT/todays-note.webp" 84 -vf "crop=1100:500:530:330,scale=760:-2:flags=lanczos"
webp "$SRC/home-quiet.png" "$OUT/plan-card.webp" 84 -vf "crop=520:600:1598:530,scale=460:-2:flags=lanczos"
webp "$SRC/home-quiet.png" "$OUT/office-still.webp" 82 -vf "crop=1570:670:48:212,scale=1200:-2:flags=lanczos"

# ---- the team's real work (docs/creative-live/v2) ----
webp "$CL/avs-interior-ad/a-editorial-frame-pick.jpg" "$OUT/work-avs-ad.webp" 82 -vf "scale=600:-2:flags=lanczos"
webp "$CL/aamdani-launch/a-scene-device-pick.jpg" "$OUT/work-aamdani-poster.webp" 82 -vf "scale=600:-2:flags=lanczos"
loop "$CL/avs-reel/reel.mp4" "$SRC/tmp/reel-full.mp4" 30
ff -i "$SRC/tmp/reel-full.mp4" -vf "scale=360:-2:flags=lanczos,format=yuv420p" -c:v libx264 -crf 29 -preset slow -g 60 -an -movflags +faststart "$OUT/work-avs-reel.mp4"
first "$OUT/work-avs-reel.mp4" "$OUT/work-avs-reel-poster.webp"

ls -la "$OUT"
du -sh "$OUT"
