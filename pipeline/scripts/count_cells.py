#!/usr/bin/env python3
import argparse
from pathlib import Path
import re


HEADER_PATTERN = re.compile(r'^(?P<x>-?\d+)_(?P<y>-?\d+)\.lotheader$')


def parse_scope(value):
    if value == 'full':
        return None
    try:
        x, y, width, height = (int(part) for part in value.split(','))
    except ValueError as error:
        raise argparse.ArgumentTypeError('scope must be full or x,y,width,height') from error
    if width < 1 or height < 1:
        raise argparse.ArgumentTypeError('scope width and height must be positive')
    return x, y, width, height


def main():
    parser = argparse.ArgumentParser(description='Count Project Zomboid map cells in a scope')
    parser.add_argument('--map-root', required=True, type=Path)
    parser.add_argument('--scope', type=parse_scope, default=None)
    args = parser.parse_args()

    cells = set()
    for path in args.map_root.iterdir():
        match = HEADER_PATTERN.match(path.name)
        if match:
            cells.add((int(match.group('x')), int(match.group('y'))))
    if not cells:
        raise SystemExit(f'no lotheader files found in {args.map_root}')

    scope = args.scope
    if scope is not None:
        sx, sy, width, height = args.scope
        cells = {
            (x, y) for x, y in cells
            if sx <= x < sx + width and sy <= y < sy + height
        }
    if not cells:
        raise SystemExit('the selected scope contains no map cells')

    print(len(cells))


if __name__ == '__main__':
    main()
