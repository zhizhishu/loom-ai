# LOOM Personal Linux/WSL preview

This archive is an isolated personal Linux x64 preview. It does not use the
Rovai desktop installation and keeps personal data outside the program files.

## Run once

```sh
sh Start-Loom.sh
```

## Install under your home directory

```sh
sh Install-Loom.sh
~/.local/share/loom-personal/Start-Loom.sh
```

Open the printed loopback URL. The bundled helper runtime uses the system
`python3` available in Ubuntu/WSL; supported Pillow wheels are bundled.
