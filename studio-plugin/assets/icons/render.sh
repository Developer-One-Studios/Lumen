#!/bin/sh
# Regenerates the Lumen toolbar icons as SVG and 128 px PNG. Needs rsvg-convert from librsvg.
# Studio only shows uploaded images, so after a change upload the PNGs as Decals to the team group,
# look up each Decal's image id in Studio, and update the ids in scripts/build-plugin.mjs.
set -e
cd "$(dirname "$0")"

# icon <name> <gradient top> <gradient bottom> <spark> <spark edge> <status dot colour or none>
icon() {
  name=$1; top=$2; bottom=$3; spark=$4; edge=$5; dot=$6
  mask=""; dotsvg=""; group="<g>"
  if [ "$dot" != "none" ]; then
    # The cut around the dot shows the toolbar through it, so the dot reads on light and dark themes.
    mask="<mask id='cut'><rect width='128' height='128' fill='white'/><circle cx='102' cy='102' r='20' fill='black'/></mask>"
    group="<g mask='url(#cut)'>"
    dotsvg="<circle cx='102' cy='102' r='14' fill='$dot'/>"
  fi
  cat > "$name.svg" <<SVG
<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128' viewBox='0 0 128 128'>
  <defs>
    <linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
      <stop offset='0' stop-color='$top'/>
      <stop offset='1' stop-color='$bottom'/>
    </linearGradient>
    <radialGradient id='glow' cx='0.5' cy='0.5' r='0.5'>
      <stop offset='0' stop-color='$spark' stop-opacity='0.45'/>
      <stop offset='1' stop-color='$spark' stop-opacity='0'/>
    </radialGradient>
    $mask
  </defs>
  $group
    <path d='M 32 18 V 96 H 84' fill='none' stroke='url(#g)' stroke-width='25' stroke-linecap='round' stroke-linejoin='round'/>
    <circle cx='88' cy='36' r='32' fill='url(#glow)'/>
    <path d='M 88 8 C 90.5 29 95 33.5 116 36 C 95 38.5 90.5 43 88 64 C 85.5 43 81 38.5 60 36 C 81 33.5 85.5 29 88 8 Z' fill='$spark' stroke='$edge' stroke-width='3' stroke-linejoin='round'/>
  </g>
  $dotsvg
</svg>
SVG
  rsvg-convert -w 128 -h 128 "$name.svg" -o "$name.png"
}

GOLD="#FFD86B #FF7A2F #FFC233 #E07A00"
BLUE="#93E2FF #6366F1 #8FD3FF #4F6BFF"

icon lumen-mark $GOLD none
for state in disconnected:#F87171 connecting:#FBBF24 connected:#34D399; do
  icon "lumen-${state%%:*}" $GOLD "${state#*:}"
  icon "inspector-${state%%:*}" $BLUE "${state#*:}"
done
