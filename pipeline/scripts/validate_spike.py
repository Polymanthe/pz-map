#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image


def main():
    parser = argparse.ArgumentParser(description='Validate pzmap2dzi spike output')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()

    base = args.output / 'html' / 'map_data' / 'base'
    map_info_path = base / 'map_info.json'
    dzi_path = base / 'layer0.dzi'
    tile_root = base / 'layer0_files'

    if not map_info_path.is_file():
        raise SystemExit(f'Missing map metadata: {map_info_path}')
    if not dzi_path.is_file():
        raise SystemExit(f'Missing DZI descriptor: {dzi_path}')

    map_info = json.loads(map_info_path.read_text(encoding='utf-8'))
    dzi = ET.parse(dzi_path).getroot()
    size = next(iter(dzi))
    jpeg_tiles = sorted(tile_root.glob('*/*.jpg'))
    if not jpeg_tiles:
        raise SystemExit(f'No JPEG tile generated under {tile_root}')

    dimensions = set()
    total_bytes = 0
    for tile in jpeg_tiles:
        with Image.open(tile) as image:
            image.verify()
            if image.format != 'JPEG':
                raise SystemExit(f'Unexpected tile format for {tile}: {image.format}')
            dimensions.add(image.size)
        total_bytes += tile.stat().st_size

    report = {
        'status': 'passed',
        'map_info': map_info,
        'dzi': {
            'format': dzi.attrib.get('Format'),
            'tile_size': int(dzi.attrib['TileSize']),
            'width': int(size.attrib['Width']),
            'height': int(size.attrib['Height']),
        },
        'tiles': {
            'jpeg_count': len(jpeg_tiles),
            'total_bytes': total_bytes,
            'dimensions': sorted([list(value) for value in dimensions]),
        },
    }
    report_path = args.output / 'spike-report.json'
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding='utf-8')
    print(json.dumps(report, indent=2, sort_keys=True))
    print(f'Validation report written to {report_path}')


if __name__ == '__main__':
    main()
