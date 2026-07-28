# Renderer spike

This spike validates that `pzmap2dzi` can render Project Zomboid Build 41 map
data from a Linux container on Apple Silicon. It renders only cell `35,32`,
floor zero, and writes its disposable output to `dist/pipeline/spike/`.

The local macOS Project Zomboid installation is used by default. Override it
for another installation by setting `PZ_ROOT` to the directory that directly
contains `media/`.

```bash
docker compose build renderer
docker compose run --rm renderer
```

Expected artifacts:

```text
dist/pipeline/spike/
├── html/map_data/base/
│   ├── layer0.dzi
│   ├── layer0_files/
│   └── map_info.json
├── render.time
├── spike-report.json
└── unpack.time
```

The game assets are mounted at `/game` in read-only mode. The renderer source
is pinned to commit `d682149cf805b556960cae71487c61cfd4683947`.

## Result

The spike passed on 2026-07-28 using the native `linux/arm64` image:

| Check | Result |
| --- | --- |
| Project Zomboid format | B41, 300 squares per cell |
| Renderer | pzmap2dzi 1.1.16 |
| Texture unpack | 14.27 s, 739 MiB peak RSS |
| Cell render | 8.33 s, 202 MiB peak RSS |
| DZI dimensions | 40064 x 23392 pixels |
| JPEG tiles | 592 files, 123 MiB |
| Total spike output | 313 MiB |
| Swap or renderer errors | None |

The generated JPEG files were decoded with Pillow and visually sampled. Roads,
vegetation, buildings, interiors, and tile boundaries render correctly.
