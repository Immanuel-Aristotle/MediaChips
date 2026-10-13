ARG NODE_BASE=node:22-bookworm-slim@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562
ARG DEBIAN_SNAPSHOT=20261006T000000Z

FROM ${NODE_BASE} AS raw-native
ARG DEBIAN_SNAPSHOT

ENV LD_LIBRARY_PATH=/usr/local/lib \
    PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:/usr/local/lib/x86_64-linux-gnu/pkgconfig

RUN rm -f /etc/apt/sources.list.d/debian.sources && \
    printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm main\n' "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list && \
    printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm-updates main\n' "$DEBIAN_SNAPSHOT" >> /etc/apt/sources.list && \
    printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' "$DEBIAN_SNAPSHOT" >> /etc/apt/sources.list && \
    apt-get update && apt-get install --no-install-recommends -y \
    autoconf automake build-essential ca-certificates cmake git libexpat1-dev \
    libfontconfig1-dev libfreetype6-dev libglib2.0-dev libheif-dev libjpeg-dev \
    liblcms2-dev libltdl-dev libopenjp2-7-dev libpng-dev librsvg2-dev \
    libtiff-dev libwebp-dev libtool libxml2-dev libzstd-dev meson ninja-build \
    pkg-config perl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/raw-native

# Pin the RAW decoder versions used by Immich's server build.
RUN git clone --filter=blob:none https://github.com/LibRaw/LibRaw.git libraw && \
    git -C libraw checkout --detach e419de08001de28ae6988ecb22df47e52b9c5eaa && \
    cd libraw && autoreconf --install && ./configure --disable-examples && \
    make -j"$(nproc)" && make install && ldconfig /usr/local/lib

RUN git clone --filter=blob:none https://github.com/ImageMagick/ImageMagick.git imagemagick && \
    git -C imagemagick checkout --detach c86de049cefb8dd739e16f0e2fdc1ef8d2006d59 && \
    cd imagemagick && CPPFLAGS="-DMAGICK_LIBRAW_VERSION_TAIL=202502" ./configure --with-modules && \
    make -j"$(nproc)" && make install && ldconfig /usr/local/lib

RUN git clone --filter=blob:none https://github.com/libvips/libvips.git libvips && \
    git -C libvips checkout --detach 24ad4d042940e6bf99a68871ba886ca8847c9c82 && \
    meson setup libvips/build libvips --buildtype=release --libdir=lib \
      -Dintrospection=disabled -Dtiff=disabled -Draw=enabled -Dmagick=enabled \
      -Dmagick-features=load && \
    ninja -C libvips/build install && ldconfig /usr/local/lib && \
    mkdir -p /usr/local/share/doc/mediachips-raw/licenses && \
    cp libraw/LICENSE.LGPL /usr/local/share/doc/mediachips-raw/licenses/LibRaw-LICENSE.LGPL && \
    cp imagemagick/LICENSE imagemagick/NOTICE /usr/local/share/doc/mediachips-raw/licenses/ && \
    cp libvips/LICENSE /usr/local/share/doc/mediachips-raw/licenses/libvips-LICENSE

RUN magick -list format | grep -E '^[[:space:]]*RW2[[:space:]]' && \
    vips -l foreign | grep -i dcraw && \
    pkg-config --modversion vips-cpp

FROM ${NODE_BASE} AS builder
ARG DEBIAN_SNAPSHOT

RUN rm -f /etc/apt/sources.list.d/debian.sources && \
    printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm main\n' "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list && \
    printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm-updates main\n' "$DEBIAN_SNAPSHOT" >> /etc/apt/sources.list && \
    printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' "$DEBIAN_SNAPSHOT" >> /etc/apt/sources.list && \
    apt-get update && apt-get install --no-install-recommends -y \
    build-essential ffmpeg git make pkg-config python3 rsync && \
    rm -rf /var/lib/apt/lists/*

COPY --from=raw-native /usr/local/ /usr/local/
ENV LD_LIBRARY_PATH=/usr/local/lib \
    PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:/usr/local/lib/x86_64-linux-gnu/pkgconfig \
    SHARP_FORCE_GLOBAL_LIBVIPS=true \
    NODE_OPTIONS=--max-old-space-size=4096
RUN ldconfig /usr/local/lib

WORKDIR /app

# file: packages/* must exist before npm ci (local plugin deps)
COPY package*.json ./
COPY packages/plugin-adult/package.json ./packages/plugin-adult/
COPY packages/plugin-stash/package.json ./packages/plugin-stash/
COPY packages/plugin-jellyfin/package.json ./packages/plugin-jellyfin/
COPY packages/plugin-plex/package.json ./packages/plugin-plex/
COPY packages/plugin-emby/package.json ./packages/plugin-emby/
COPY packages/plugin-tmdb/package.json ./packages/plugin-tmdb/
RUN npm ci --ignore-scripts && \
    npm rebuild sharp --build-from-source && \
    npm rebuild better-sqlite3

COPY . .

ARG SOURCE_REVISION=unknown
ARG MEDIACHIPS_VERSION=1.12.0-rw2.1
LABEL org.opencontainers.image.source="https://github.com/Immanuel-Aristotle/MediaChips" \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.version=$MEDIACHIPS_VERSION

RUN node scripts/compile.mjs backend && \
    npx vite build && \
    ldd node_modules/sharp/build/Release/sharp-linux-x64.node > /tmp/sharp-ldd && \
    grep -q 'libvips-cpp' /tmp/sharp-ldd && \
    ! grep -q 'not found' /tmp/sharp-ldd

FROM ${NODE_BASE} AS runner
ARG DEBIAN_SNAPSHOT

RUN rm -f /etc/apt/sources.list.d/debian.sources && \
    printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm main\n' "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list && \
    printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm-updates main\n' "$DEBIAN_SNAPSHOT" >> /etc/apt/sources.list && \
    printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' "$DEBIAN_SNAPSHOT" >> /etc/apt/sources.list && \
    apt-get update && apt-get install --no-install-recommends -y \
    ca-certificates ffmpeg gosu libexpat1 libfontconfig1 libfreetype6 libglib2.0-0 \
    libheif1 libjpeg62-turbo liblcms2-2 libopenjp2-7 libpng16-16 librsvg2-2 \
    libtiff6 libwebp7 libwebpdemux2 libwebpmux3 libxml2 libzstd1 passwd perl tini wget && \
    rm -rf /var/lib/apt/lists/*

COPY --from=raw-native /usr/local/ /usr/local/
RUN ldconfig /usr/local/lib && \
    magick -list format | grep -E '^[[:space:]]*RW2[[:space:]]' && \
    vips -l foreign | grep -i dcraw

WORKDIR /app

COPY package*.json ./
COPY packages/plugin-adult/package.json ./packages/plugin-adult/
COPY packages/plugin-stash/package.json ./packages/plugin-stash/
COPY packages/plugin-jellyfin/package.json ./packages/plugin-jellyfin/
COPY packages/plugin-plex/package.json ./packages/plugin-plex/
COPY packages/plugin-emby/package.json ./packages/plugin-emby/
COPY packages/plugin-tmdb/package.json ./packages/plugin-tmdb/
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder /app/node_modules/@img ./node_modules/@img
COPY --from=builder /app/.backend-build ./.backend-build
COPY --from=builder /app/api/db/migrations-drizzle ./api/db/migrations-drizzle
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/LICENSE ./LICENSE
COPY --from=builder /app/scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=raw-native /usr/local/share/doc/mediachips-raw/ /usr/share/doc/mediachips-raw/

ENV FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    LD_LIBRARY_PATH=/usr/local/lib \
    SHARP_FORCE_GLOBAL_LIBVIPS=true \
    NODE_ENV=production \
    MEDIA_CHIPS_ALLOW_LAN=1 \
    MEDIA_CHIPS_DATA_DIR=/data \
    MEDIACHIPS_RAW_MODE=embedded \
    PUID=1001 \
    PGID=1001

RUN chmod +x /usr/local/bin/docker-entrypoint.sh && \
    mkdir -p /app/app_storage /data && \
    groupadd --gid 1001 nodejs && \
    useradd --uid 1001 --gid nodejs --no-create-home --shell /usr/sbin/nologin nodejs && \
    chown -R nodejs:nodejs /app /data

EXPOSE 12321

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:12321/api/health >/dev/null || exit 1

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", ".backend-build/app/server.js"]
