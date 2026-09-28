#!/bin/sh
set -e
cd "$(dirname "$0")"
for theme in light dark; do
  npx tsx author.ts "$theme"
  npx clayzo export "banner-$theme.json" "../assets/banner-$theme.gif" --format gif --tier final --full-resolution --no-progress
done
