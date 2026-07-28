#!/usr/bin/env bash
set -Eeuo pipefail

readonly CONF=/opt/pzmap2dzi/conf/spike.yaml
readonly MAP_ROOT='/game/media/maps/Muldraugh, KY'
readonly CELL_X=35
readonly CELL_Y=32

for source in \
  "${MAP_ROOT}/${CELL_X}_${CELL_Y}.lotheader" \
  "${MAP_ROOT}/world_${CELL_X}_${CELL_Y}.lotpack" \
  "${MAP_ROOT}/chunkdata_${CELL_X}_${CELL_Y}.bin"; do
  if [[ ! -f "${source}" ]]; then
    printf 'Missing Project Zomboid source: %s\n' "${source}" >&2
    exit 1
  fi
done

python - <<'PY'
import json
import platform

import PIL
import lupa
import pyclipper
import yaml
from pzmap2dzi.lotheader import get_version_info

map_root = '/game/media/maps/Muldraugh, KY'
version = get_version_info(map_root)
if version['pz_version'] != 'B41':
    raise SystemExit('Expected B41 assets, got {}'.format(version['pz_version']))

print(json.dumps({
    'architecture': platform.machine(),
    'python': platform.python_version(),
    'pillow': PIL.__version__,
    'lupa': lupa.__version__,
    'pyclipper': pyclipper.__version__,
    'pyyaml': yaml.__version__,
    'map': version,
}, indent=2, sort_keys=True, default=list))
PY

printf '\nUnpacking texture packs...\n'
/usr/bin/time -v -o /output/unpack.time \
  python main.py --conf "${CONF}" unpack

printf '\nRendering B41 cell %s,%s...\n' "${CELL_X}" "${CELL_Y}"
/usr/bin/time -v -o /output/render.time \
  python main.py --conf "${CONF}" render base

python /opt/spike/validate_spike.py /output
