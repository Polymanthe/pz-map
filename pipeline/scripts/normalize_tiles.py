#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import uuid
import xml.etree.ElementTree as ET

from PIL import Image


TILE_PATTERN = re.compile(r'^(?P<x>\d+)_(?P<y>\d+)\.(?P<ext>[a-z0-9]+)$')
NORMALIZER_VERSION = 2


def parse_args():
    parser = argparse.ArgumentParser(description='Convert pzmap2dzi output to Leaflet tiles')
    parser.add_argument('--source', required=True, type=Path, help='DZI map directory')
    parser.add_argument('--output', required=True, type=Path, help='Output directory')
    parser.add_argument('--floor', type=int, default=0)
    parser.add_argument('--max-zoom', type=int, default=6)
    parser.add_argument('--build-id', help='Override cache-busting build identifier')
    parser.add_argument('--copy', action='store_true', help='Copy full tiles instead of hard-linking')
    parser.add_argument('--force', action='store_true')
    return parser.parse_args()


def load_source(source, floor):
    map_info_path = source / 'map_info.json'
    dzi_path = source / f'layer{floor}.dzi'
    tile_root = source / f'layer{floor}_files'
    for path in (map_info_path, dzi_path, tile_root):
        if not path.exists():
            raise SystemExit(f'Missing source: {path}')

    map_info = json.loads(map_info_path.read_text(encoding='utf-8'))
    dzi = ET.parse(dzi_path).getroot()
    size = next(iter(dzi))
    descriptor = {
        'format': dzi.attrib['Format'].lower(),
        'tile_size': int(dzi.attrib['TileSize']),
        'width': int(size.attrib['Width']),
        'height': int(size.attrib['Height']),
    }
    levels = sorted(
        int(path.name)
        for path in tile_root.iterdir()
        if path.is_dir()
        and path.name.isdigit()
        and any(path.glob(f"*.{descriptor['format']}"))
    )
    if not levels:
        raise SystemExit(f'No DZI levels found in {tile_root}')
    return map_info, descriptor, tile_root, levels


def select_levels(descriptor, available_levels, max_zoom):
    descriptor_max = math.ceil(math.log2(max(descriptor['width'], descriptor['height'])))
    available_max = max(available_levels)
    if available_max != descriptor_max:
        raise SystemExit(
            f'DZI level mismatch: descriptor expects {descriptor_max}, files end at {available_max}'
        )

    overview_level = math.ceil(math.log2(descriptor['tile_size']))
    source_min = min(overview_level, available_max)
    source_max = min(available_max, source_min + max_zoom)
    if source_max - source_min < max_zoom:
        source_min = max(0, source_max - max_zoom)
    selected = list(range(source_min, source_max + 1))
    missing = [level for level in selected if level not in available_levels]
    if missing:
        raise SystemExit(f'Missing selected DZI levels: {missing}')
    return descriptor_max, selected


def link_or_copy(source, destination, copy_only=False):
    if copy_only:
        shutil.copy2(source, destination)
        return 'copied'
    try:
        os.link(source, destination)
        return 'linked'
    except OSError:
        shutil.copy2(source, destination)
        return 'copied'


def normalize_tile(source, destination, tile_size, extension, copy_only=False):
    with Image.open(source) as image:
        if image.size == (tile_size, tile_size):
            return link_or_copy(source, destination, copy_only)

        if extension in ('jpg', 'jpeg'):
            canvas = Image.new('RGB', (tile_size, tile_size))
            canvas.paste(image.convert('RGB'), (0, 0))
            canvas.save(destination, quality=90, optimize=True, progressive=True)
        else:
            canvas = Image.new('RGBA', (tile_size, tile_size))
            layer = image.convert('RGBA')
            canvas.alpha_composite(layer, (0, 0))
            canvas.save(destination, quality=90)
    return 'padded'


def normalize_tiles(tile_root, destination, selected_levels, extension, tile_size, copy_only=False):
    counts = {'linked': 0, 'copied': 0, 'padded': 0}
    for zoom, source_level in enumerate(selected_levels):
        source_dir = tile_root / str(source_level)
        for tile in source_dir.iterdir():
            match = TILE_PATTERN.match(tile.name)
            if not match or match.group('ext') != extension:
                continue
            target_dir = destination / str(zoom) / match.group('x')
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / f"{match.group('y')}.{extension}"
            method = normalize_tile(tile, target, tile_size, extension, copy_only)
            counts[method] += 1
    if sum(counts.values()) == 0:
        raise SystemExit('No tiles matched the selected levels')
    return counts


def tile_set_signature(tile_root, selected_levels, extension):
    signature = hashlib.sha256()
    for level in selected_levels:
        for tile in sorted((tile_root / str(level)).glob(f'*.{extension}')):
            stat = tile.stat()
            signature.update(f'{level}/{tile.name}:{stat.st_size}:{stat.st_mtime_ns}\n'.encode('utf-8'))
    return signature.hexdigest()


def make_manifest(
    map_info,
    descriptor,
    descriptor_max,
    selected_levels,
    floor,
    tile_signature,
    build_id=None,
):
    source_max = selected_levels[-1]
    additional_skip = descriptor_max - source_max
    projection_scale = 2 ** (int(map_info.get('skip', 0)) + additional_skip)
    width = math.ceil(descriptor['width'] / (2 ** additional_skip))
    height = math.ceil(descriptor['height'] / (2 ** additional_skip))
    fingerprint = build_id or hashlib.sha256(json.dumps({
            'map': map_info,
            'descriptor': descriptor,
            'levels': selected_levels,
            'floor': floor,
            'normalizerVersion': NORMALIZER_VERSION,
            'tileSignature': tile_signature,
        }, sort_keys=True).encode('utf-8')).hexdigest()[:12]
    extension = descriptor['format']
    return {
        'schemaVersion': 1,
        'buildId': fingerprint,
        'title': 'Project Zomboid Map',
        'pzVersion': map_info.get('pz_version'),
        'extent': {'width': width, 'height': height},
        'zoom': {
            'min': 0,
            'max': len(selected_levels) - 1,
            'sourceMin': selected_levels[0],
            'sourceMax': source_max,
        },
        'tileSize': descriptor['tile_size'],
        'projection': {
            'type': 'isometric',
            'x0': map_info['x0'],
            'y0': map_info['y0'],
            'squareSize': map_info['sqr'],
            'scale': projection_scale,
        },
        'floors': [{
            'id': floor,
            'label': 'Sol' if floor == 0 else f'Etage {floor}',
            'format': extension,
            'url': f'/tiles/{floor}/{{z}}/{{x}}/{{y}}.{extension}?v={fingerprint}',
        }],
        'source': {
            'renderer': 'pzmap2dzi',
            'rendererVersion': map_info.get('pzmap2dzi_version'),
            'rendererCommit': map_info.get('git_commit'),
            'normalizerVersion': NORMALIZER_VERSION,
            'cellRects': map_info.get('cell_rects', []),
            'nativeWidth': descriptor['width'],
            'nativeHeight': descriptor['height'],
        },
    }


def publish_staging(staging, output):
    if not output.exists():
        staging.replace(output)
        return

    backup = output.parent / f'.{output.name}.old-{uuid.uuid4().hex}'
    output.replace(backup)
    try:
        staging.replace(output)
    except BaseException:
        backup.replace(output)
        raise
    if backup.is_dir():
        shutil.rmtree(backup)
    else:
        backup.unlink()


def validate_paths(source, output):
    protected = {Path.cwd().resolve(), Path.home().resolve(), Path(output.anchor)}
    if output in protected:
        raise SystemExit(f'Refusing unsafe output directory: {output}')
    if source == output or source in output.parents or output in source.parents:
        raise SystemExit('Source and output directories must not overlap')


def main():
    args = parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    validate_paths(source, output)
    if output.exists() and not args.force:
        raise SystemExit(f'Output already exists: {output} (use --force to replace it)')
    output.parent.mkdir(parents=True, exist_ok=True)

    map_info, descriptor, tile_root, available = load_source(source, args.floor)
    descriptor_max, selected = select_levels(descriptor, available, args.max_zoom)
    tile_signature = tile_set_signature(tile_root, selected, descriptor['format'])
    manifest = make_manifest(
        map_info,
        descriptor,
        descriptor_max,
        selected,
        args.floor,
        tile_signature,
        args.build_id,
    )

    staging = output.parent / f'.{output.name}.tmp-{uuid.uuid4().hex}'
    try:
        tile_destination = staging / 'tiles' / str(args.floor)
        counts = normalize_tiles(
            tile_root,
            tile_destination,
            selected,
            descriptor['format'],
            descriptor['tile_size'],
            args.copy,
        )
        (staging / 'map-manifest.json').write_text(
            json.dumps(manifest, indent=2, sort_keys=True), encoding='utf-8'
        )
        publish_staging(staging, output)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise

    print(json.dumps({
        'status': 'passed',
        'output': str(output),
        'levels': selected,
        'tiles': counts,
        'manifest': manifest,
    }, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
