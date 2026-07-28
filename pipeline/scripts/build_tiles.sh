#!/usr/bin/env bash
set -Eeuo pipefail

PIPELINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${PIPELINE_DIR}/.." && pwd)"
DEFAULT_PZ_ROOT="${HOME}/Library/Application Support/Steam/steamapps/common/ProjectZomboid/Project Zomboid.app/Contents/Java"

PZ_ROOT="${PZ_ROOT:-${DEFAULT_PZ_ROOT}}"
RENDER_OUTPUT="${REPO_DIR}/dist/pipeline/render/full"
DIST_OUTPUT="${REPO_DIR}/dist/map"
SCOPE=full
WORKERS=4
CACHE_MB=1024
SHM_SIZE=4g
MAX_ZOOM=6
QUALITY=78
IMAGE=pz-map-renderer:local
LOG_FILE=''

usage() {
  cat <<'EOF'
Usage: pipeline/scripts/build_tiles.sh [options]

Options:
  --pz-root PATH          Directory containing media/ (default: local Steam path)
  --render-output PATH    Persistent pzmap2dzi output (default: ./dist/pipeline/render/full)
  --dist PATH             Published map directory (default: ./dist/map)
  --scope RANGE           full or x,y,width,height (default: full)
  --workers N             Renderer workers (default: 4)
  --cache-mb N            Shared image cache limit (default: 1024)
  --shm-size SIZE         Container shared memory limit (default: 4g)
  --log-file PATH         Build log (default: ./dist/pipeline/logs/build-<timestamp>.log)
  --max-zoom N            Leaflet maximum zoom (default: 6)
  --quality N             JPEG quality (default: 78)
  --help                  Show this help

The same render output can be reused after interruption. A scope is rendered in
one pzmap2dzi execution because downsampled tiles cannot be composed safely
across independent source-cell batches.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pz-root) PZ_ROOT="$2"; shift 2 ;;
    --render-output) RENDER_OUTPUT="$2"; shift 2 ;;
    --dist) DIST_OUTPUT="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --workers) WORKERS="$2"; shift 2 ;;
    --cache-mb) CACHE_MB="$2"; shift 2 ;;
    --shm-size) SHM_SIZE="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --max-zoom) MAX_ZOOM="$2"; shift 2 ;;
    --quality) QUALITY="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

MAP_ROOT="${PZ_ROOT}/media/maps/Muldraugh, KY"
if [[ ! -d "${MAP_ROOT}" ]]; then
  printf 'Map directory not found: %s\n' "${MAP_ROOT}" >&2
  exit 1
fi
for value in "${WORKERS}" "${CACHE_MB}" "${MAX_ZOOM}" "${QUALITY}"; do
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    printf 'Expected a non-negative integer, got: %s\n' "${value}" >&2
    exit 2
  fi
done
if (( WORKERS < 1 || QUALITY < 1 || QUALITY > 100 )); then
  printf 'Invalid worker count or JPEG quality.\n' >&2
  exit 2
fi
if [[ ! "${SHM_SIZE}" =~ ^[1-9][0-9]*[bkmgBKMG]?$ ]]; then
  printf 'Invalid shared memory size: %s\n' "${SHM_SIZE}" >&2
  exit 2
fi

RENDER_OUTPUT="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "${RENDER_OUTPUT}")"
DIST_OUTPUT="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "${DIST_OUTPUT}")"
DIST_ROOT="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "${REPO_DIR}/dist")"

require_dist_child() {
  local name="$1"
  local path="$2"
  if [[ "${path}" == "${DIST_ROOT}" || "${path}/" != "${DIST_ROOT}/"* ]]; then
    printf '%s must be a child of %s, got: %s\n' "${name}" "${DIST_ROOT}" "${path}" >&2
    exit 2
  fi
}

require_dist_child 'Render output' "${RENDER_OUTPUT}"
require_dist_child 'Published map output' "${DIST_OUTPUT}"
if [[ "${DIST_OUTPUT}/" == "${RENDER_OUTPUT}/"* || "${RENDER_OUTPUT}/" == "${DIST_OUTPUT}/"* ]]; then
  printf 'Render and published map outputs must not overlap.\n' >&2
  exit 2
fi

if [[ -z "${LOG_FILE}" ]]; then
  LOG_FILE="${REPO_DIR}/dist/pipeline/logs/build-$(date '+%Y%m%d-%H%M%S').log"
fi
LOG_FILE="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "${LOG_FILE}")"
require_dist_child 'Log file' "${LOG_FILE}"
mkdir -p "$(dirname "${LOG_FILE}")"
exec > >(tee -a "${LOG_FILE}") 2>&1

mkdir -p "${RENDER_OUTPUT}"
printf '[%s] Log file: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${LOG_FILE}"
printf '[%s] Shared memory: %s, tile cache: %s MiB, workers: %s\n' \
  "$(date '+%Y-%m-%d %H:%M:%S')" "${SHM_SIZE}" "${CACHE_MB}" "${WORKERS}"

printf 'Building renderer image...\n'
docker build \
  --file "${PIPELINE_DIR}/Dockerfile" \
  --tag "${IMAGE}" \
  "${REPO_DIR}"

printf 'Inspecting map pyramid...\n'
inspect_output="$(docker run --rm \
  --volume "${PZ_ROOT}:/game:ro" \
  --entrypoint python \
  "${IMAGE}" \
  -c "from pzmap2dzi.pzdzi import IsoDZI; d=IsoDZI('/game/media/maps/Muldraugh, KY', output='/tmp/preflight', tile_size=1024, layer_range=[0,1], dzi_cell_range='auto' if '${SCOPE}' == 'full' else [[int(v) for v in '${SCOPE}'.split(',')]], render_cell_range='all', enable_cache=False); print(d.levels - 1)")"
NATIVE_MAX_LEVEL="${inspect_output##*$'\n'}"
if [[ ! "${NATIVE_MAX_LEVEL}" =~ ^[0-9]+$ ]]; then
  printf 'Could not determine the native DZI level from:\n%s\n' "${inspect_output}" >&2
  exit 1
fi

OVERVIEW_LEVEL=10
TARGET_MAX_LEVEL=$((OVERVIEW_LEVEL + MAX_ZOOM))
OMIT_LEVELS=$((NATIVE_MAX_LEVEL - TARGET_MAX_LEVEL))
if (( OMIT_LEVELS < 0 )); then OMIT_LEVELS=0; fi
printf 'Native level: %s, target level: %s, omitted levels: %s\n' \
  "${NATIVE_MAX_LEVEL}" "${TARGET_MAX_LEVEL}" "${OMIT_LEVELS}"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT
SOURCE_CELL_COUNT="$(python3 "${PIPELINE_DIR}/scripts/count_cells.py" \
  --map-root "${MAP_ROOT}" \
  --scope "${SCOPE}")"

write_config() {
  local path="$1"
  local dzi_range=auto
  local render_range=all
  if [[ "${SCOPE}" != full ]]; then
    IFS=',' read -r scope_x scope_y scope_width scope_height <<< "${SCOPE}"
    dzi_range="[[${scope_x}, ${scope_y}, ${scope_width}, ${scope_height}]]"
    render_range="[[${scope_x}, ${scope_y}, ${scope_width}, ${scope_height}]]"
  fi
  cat > "${path}" <<EOF
pz_root: /game
output_root: /output
mod_root: /mods
custom_root: /custom
map_conf_default: /opt/pzmap2dzi/conf/default.txt
map_conf:
  - /opt/pzmap2dzi/conf/vanilla.txt
use_depend_texture_only: true
base_map: default
mod_maps:
render_conf:
  verbose: true
  worker_count: ${WORKERS}
  break_key: ''
  tile_size: 1024
  tile_align_levels: 3
  layer_range: [0, 1]
  dzi_cell_range: ${dzi_range}
  render_cell_range: ${render_range}
  omit_levels: ${OMIT_LEVELS}
  image_fmt: webp
  image_fmt_base_layer0: jpg
  image_save_options:
    jpg: {quality: ${QUALITY}, optimize: true, progressive: true}
  enable_cache: true
  cache_limit_mb: ${CACHE_MB}
  use_mark: false
  plants_conf:
    season: summer2
    snow: false
    flower: false
    large_bush: false
    tree_size: 2
    jumbo_tree_size: 3
    jumbo_tree_type: 1
    no_ground_cover: false
    unify_tree_type: 0
EOF
}

CONFIG="${TEMP_DIR}/render.yaml"
write_config "${CONFIG}"

printf 'Preparing textures...\n'
docker run --rm \
  --env PYTHONUNBUFFERED=1 \
  --volume "${PZ_ROOT}:/game:ro" \
  --volume "${RENDER_OUTPUT}:/output" \
  --volume "${CONFIG}:/work/render.yaml:ro" \
  --entrypoint python \
  "${IMAGE}" main.py --conf /work/render.yaml unpack

printf '\nRendering scope %s, %s source cells\n' "${SCOPE}" "${SOURCE_CELL_COUNT}"
docker run --rm \
  --env PYTHONUNBUFFERED=1 \
  --shm-size "${SHM_SIZE}" \
  --volume "${PZ_ROOT}:/game:ro" \
  --volume "${RENDER_OUTPUT}:/output" \
  --volume "${CONFIG}:/work/render.yaml:ro" \
  --entrypoint python \
  "${IMAGE}" main.py --conf /work/render.yaml render base

printf '\nNormalizing Leaflet tiles...\n'
normalize_args=(
  --source "${RENDER_OUTPUT}/html/map_data/base"
  --output "${DIST_OUTPUT}"
  --max-zoom "${MAX_ZOOM}"
)
if [[ -d "${DIST_OUTPUT}" ]]; then normalize_args+=(--force); fi
python3 "${PIPELINE_DIR}/scripts/normalize_tiles.py" "${normalize_args[@]}"

printf '\nMap build complete: %s\n' "${DIST_OUTPUT}"
printf 'Build log: %s\n' "${LOG_FILE}"
