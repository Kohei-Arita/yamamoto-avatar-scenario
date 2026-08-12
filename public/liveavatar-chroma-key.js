const DEFAULT_OPTIONS = {
  minHue: 85,
  maxHue: 160,
  minSaturation: 0.22,
  minValue: 0.22,
  minGreenChannel: 64,
  minGreenDifference: 22,
  minGreenness: 0.16,
  threshold: 1.18,
  leftEdgeCropRatio: 0.04,
  topLeftCropHeightRatio: 0.34,
  topLeftCropWidthMultiplier: 3.6
};

function clampByte(value) {
  return Math.max(0, Math.min(255, value));
}

function applyLeftEdgeMask(targetCanvas, context, options) {
  const leftEdgeCropWidth = Math.round(targetCanvas.width * options.leftEdgeCropRatio);
  const topLeftCropHeight = Math.round(targetCanvas.height * options.topLeftCropHeightRatio);
  const topLeftCropWidth = Math.round(leftEdgeCropWidth * options.topLeftCropWidthMultiplier);

  if (leftEdgeCropWidth <= 0) {
    return;
  }

  context.save();
  context.globalCompositeOperation = "destination-out";
  context.fillStyle = "#000";

  // Remove a thin strip on the left edge to hide the occasional un-keyed border.
  context.fillRect(0, 0, leftEdgeCropWidth, targetCanvas.height);

  // Add a wider taper near the top-left corner where the source matte is most fragile.
  if (topLeftCropHeight > 0) {
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(topLeftCropWidth, 0);
    context.lineTo(leftEdgeCropWidth, topLeftCropHeight);
    context.lineTo(0, topLeftCropHeight);
    context.closePath();
    context.fill();
  }

  context.restore();
}

function toHueSaturationValue(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;

  if (delta !== 0) {
    if (max === r) {
      hue = ((g - b) / delta) % 6;
    } else if (max === g) {
      hue = (b - r) / delta + 2;
    } else {
      hue = (r - g) / delta + 4;
    }

    hue *= 60;

    if (hue < 0) {
      hue += 360;
    }
  }

  return {
    hue,
    saturation: max === 0 ? 0 : delta / max,
    value: max / 255
  };
}

export function clearChromaKeyCanvas(targetCanvas) {
  const context = targetCanvas?.getContext("2d");

  if (!context || !targetCanvas) {
    return;
  }

  context.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
}

export function applyChromaKey(sourceVideo, targetCanvas, options = {}) {
  if (!sourceVideo || !targetCanvas) {
    return;
  }

  const context = targetCanvas.getContext("2d", {
    willReadFrequently: true,
    alpha: true
  });

  if (!context || sourceVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  const videoWidth = sourceVideo.videoWidth;
  const videoHeight = sourceVideo.videoHeight;

  if (!videoWidth || !videoHeight) {
    return;
  }

  if (targetCanvas.width !== videoWidth || targetCanvas.height !== videoHeight) {
    targetCanvas.width = videoWidth;
    targetCanvas.height = videoHeight;
  }

  const settings = {
    ...DEFAULT_OPTIONS,
    ...options
  };

  context.clearRect(0, 0, videoWidth, videoHeight);
  context.drawImage(sourceVideo, 0, 0, videoWidth, videoHeight);

  const imageData = context.getImageData(0, 0, videoWidth, videoHeight);
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const { hue, saturation, value } = toHueSaturationValue(red, green, blue);
    const greenDifference = green - Math.max(red, blue);
    const greenness = greenDifference / (green || 1);
    const isGreen =
      hue >= settings.minHue &&
      hue <= settings.maxHue &&
      saturation > settings.minSaturation &&
      value > settings.minValue &&
      green >= settings.minGreenChannel &&
      greenDifference >= settings.minGreenDifference &&
      greenness >= settings.minGreenness &&
      green > red * settings.threshold &&
      green > blue * settings.threshold;

    if (!isGreen) {
      continue;
    }

    const alphaValue = Math.max(0, 1 - greenness * 4);

    data[index + 3] = alphaValue < 0.2 ? 0 : clampByte(Math.round(alphaValue * 255));
  }

  context.putImageData(imageData, 0, 0);
  applyLeftEdgeMask(targetCanvas, context, settings);
}

export function setupChromaKey(sourceVideo, targetCanvas, options = {}) {
  let animationFrameId = null;
  let stopped = false;

  const render = () => {
    if (stopped) {
      return;
    }

    applyChromaKey(sourceVideo, targetCanvas, options);
    animationFrameId = window.requestAnimationFrame(render);
  };

  render();

  return () => {
    stopped = true;

    if (animationFrameId !== null) {
      window.cancelAnimationFrame(animationFrameId);
    }
  };
}
