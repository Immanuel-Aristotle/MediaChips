# Panasonic RW2 image support

This page describes the RW2 processing modes, metadata, and cache used by this
MediaChips source fork. The [root README](../README.md) remains the project
entry point. This page does not describe image publication or NAS deployment.

## Processing modes

Set `MEDIACHIPS_RAW_MODE` to choose how MediaChips creates browser previews.
The default is `embedded`.

| Value | Input used for the preview | Use |
| --- | --- | --- |
| `embedded` | The first available JPEG in this order: `JpgFromRaw2`, `JpgFromRaw`, `PreviewImage` | Uses the camera-rendered preview. |
| `develop` | RAW sensor data decoded by Sharp through the system libvips RAW loader | Develops pixels using the installed LibRaw decoder. |

The value is case-sensitive. Any value other than `embedded` or `develop`
raises a configuration error. A selected mode does not switch to the other
mode after an error. In embedded mode, a missing tag is reported separately
from an extraction error. In develop mode, Sharp/libvips decode errors are
returned with their cause.

The `embedded` mode checks `JpgFromRaw2` before the smaller JPEG tags. The
current Panasonic DC-S5M2 samples contain both `JpgFromRaw2` and `JpgFromRaw`.
The largest tag is not assumed to exist in every RW2 file.

## Dimensions and orientation

MediaChips reads source dimensions and orientation from the RW2 metadata. It
does not use an embedded JPEG's dimensions as the dimensions of the RAW source.
The stored display dimensions account for EXIF orientation. If an extracted
JPEG contains its own orientation, Sharp applies that orientation; otherwise,
MediaChips applies the source RAW orientation once.

The media record continues to refer to the original `.rw2` file. MediaChips
serves a JPEG for a viewer request that includes `maxEdge`, and an ordinary
file download remains the RW2 original.

## Generated files and cache

Generated thumbnails and cache manifests live under the configured MediaChips
data directory:

```text
/data/media/images/thumbs/<media-id>.jpg
/data/media/images/thumbs/<media-id>.raw.json
```

The manifest records the source SHA-256, file size, modification time,
processing mode, and cache pipeline version. A mismatch causes the thumbnail
to be regenerated. The cache key uses the stable MediaChips media ID, so a
MediaChips move retains its association with that media record.

MediaChips does not write a preview or metadata sidecar beside an RW2 source.
The source file is opened for reading. ExifTool tasks and Sharp decode
operations have a 120-second timeout. At most two RAW conversion operations
run at once, with up to eight waiting. Cache writes use a temporary file and
atomic replacement; a failed write reports its error and removes the temporary
file.

## Container build dependencies

The Dockerfile pins the Node base image by its linux/amd64 manifest digest and
uses a dated Debian package snapshot. The native RAW libraries are built from
fixed source commits:

| Component | Pinned source |
| --- | --- |
| Node | `node:22-bookworm-slim`, linux/amd64 manifest `efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562` |
| Debian packages | Snapshot `20261006T000000Z` |
| LibRaw 0.22.2-1 | `e419de08001de28ae6988ecb22df47e52b9c5eaa` |
| ImageMagick 7.1.2-21 | `c86de049cefb8dd739e16f0e2fdc1ef8d2006d59` |
| libvips 8.18.7 | `24ad4d042940e6bf99a68871ba886ca8847c9c82` |
| exiftool-vendored | npm `39.0.1`, recorded in `package-lock.json` |

Sharp is rebuilt with `SHARP_FORCE_GLOBAL_LIBVIPS=true`. The build checks that
Sharp links to libvips and that the final image exposes both the LibRaw loader
and ImageMagick's RW2 format. The image includes license files for MediaChips,
LibRaw, ImageMagick, and libvips under their respective application and
documentation paths. The ExifTool license remains with its installed npm
package.

The source library versions follow the build approach used in the
[Immich base image](https://github.com/immich-app/base-images/blob/2692ae751f7760b3b135cb422c3e2ebec8893f8a/server/Dockerfile).
MediaChips performs its own metadata, preview, and cache operations; it does
not call an Immich service.
