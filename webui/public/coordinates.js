export function pzToImage(projection, x, y, z = 0) {
  const { x0, y0, squareSize, scale } = projection;
  return {
    x: (x0 + ((x - y) * squareSize) / 2) / scale,
    y: (y0 + ((x + y) * squareSize) / 4 - 1.5 * z * squareSize) / scale,
  };
}

export function imageToPz(projection, imageX, imageY, z = 0) {
  const { x0, y0, squareSize, scale } = projection;
  const dx = imageX * scale - x0;
  const dy = imageY * scale - y0;
  const layerOffset = 1.5 * z * squareSize;
  return {
    x: (dx + 2 * (dy + layerOffset)) / squareSize,
    y: (-dx + 2 * (dy + layerOffset)) / squareSize,
    z,
  };
}

export function isImagePointInside(extent, point) {
  return point.x >= 0 && point.y >= 0 && point.x < extent.width && point.y < extent.height;
}
