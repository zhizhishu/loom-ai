#!/bin/sh
set -eu
dest=$1
cache=${2:-/tmp/loom-office-download-cache}
version=25.8.7
sha=7f4d7b2e36921eec5122c655249a24cc88935ee357e8261fd3bccd15aa1f7b9f
url="https://download.documentfoundation.org/libreoffice/stable/$version/deb/x86_64/LibreOffice_${version}_Linux_x86-64_deb.tar.gz"
mkdir -p "$cache"
archive="$cache/LibreOffice_${version}_Linux_x86-64_deb.tar.gz"
if [ ! -f "$archive" ]; then curl -fL --retry 3 -o "$archive" "$url"; fi
echo "$sha  $archive" | sha256sum -c - >/dev/null
rm -rf "$dest"
mkdir -p "$dest/libreoffice" "$dest/poppler/bin" "$dest/poppler/lib"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$archive" -C "$tmp"
debdir=$(find "$tmp" -type d -name DEBS | head -1)
for deb in \
  libreoffice25.8-ure_*.deb \
  libreoffice25.8_*.deb \
  libreoffice25.8-impress_*.deb \
  libreoffice25.8-en-us_*.deb \
  libobasis25.8-core_*.deb \
  libobasis25.8-impress_*.deb \
  libobasis25.8-en-us_*.deb \
  libobasis25.8-images_*.deb \
  libobasis25.8-ooofonts_*.deb \
  libobasis25.8-ooolinguistic_*.deb
do
  for file in "$debdir"/$deb; do [ -f "$file" ] && dpkg-deb -x "$file" "$tmp/root"; done
done
cp -a "$tmp/root/opt/libreoffice25.8/." "$dest/libreoffice/"
rm -rf "$dest/libreoffice/help" "$dest/libreoffice/readmes"
cp /usr/bin/pdftoppm "$dest/poppler/bin/pdftoppm"
python3 - "$dest" <<'PY'
import os,re,shutil,subprocess,sys
dest=sys.argv[1]
out=subprocess.check_output(['ldd',os.path.join(dest,'poppler','bin','pdftoppm')],text=True)
libs={}
for line in out.splitlines():
 m=re.match(r'\s*(\S+)\s+=>\s+(/\S+)',line)
 if m and not m.group(1).startswith(('linux-vdso','ld-linux')): libs[m.group(1)]=os.path.realpath(m.group(2))
for soname,path in sorted(libs.items()): shutil.copy2(path,os.path.join(dest,'poppler','lib',soname))
print(f'pdftoppm runtime closure: {len(libs)} libraries')
PY
chmod -R a+rX "$dest"
cat > "$dest/office-bundle.json" <<EOF
{"schema":1,"libreOfficeVersion":"$version","libreOfficeArchiveSha256":"$sha","portable":true}
EOF
echo "office runtime staged at $dest"
