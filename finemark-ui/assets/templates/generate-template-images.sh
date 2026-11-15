#!/bin/sh
# Regenerates the pre-rendered JPEG backgrounds used by create-certificate.html.
#
# The app stamps certificate text onto a raster background. Rendering the
# source PDFs client-side with PDF.js is prohibitively slow for
# certificate-template.pdf (~12k vector objects, ~12s even in native
# renderers), so we pre-render each template once here and the page loads
# the JPEG directly. PDF.js remains as a fallback when a .jpg is missing.
#
# 180 DPI on an A4 page = 1490x2106 px, matching the exact resolution and
# JPEG quality (92) the client-side pipeline produced, so output
# certificates are unchanged.
#
# Run from this directory after replacing either template PDF:
#   ./generate-template-images.sh
# Requires docker (uses a throwaway alpine container for poppler-utils).

set -eu
cd "$(dirname "$0")"

docker run --rm -v "$PWD":/data alpine:latest sh -c '
  apk add --no-cache poppler-utils >/dev/null
  cd /data
  pdftoppm -r 180 -jpeg -jpegopt quality=92 -singlefile certificate-template.pdf certificate-template
  pdftoppm -r 180 -jpeg -jpegopt quality=92 -singlefile "Unique paper.pdf" "Unique paper"
'

ls -la ./*.jpg
echo "Done. Rebuild the frontend image to deploy."
