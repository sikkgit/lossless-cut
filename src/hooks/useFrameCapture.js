import dataUriToBuffer from 'data-uri-to-buffer';
import pMap from 'p-map';
import { useCallback } from 'react';

import { getSuffixedOutPath, getOutDir, transferTimestamps, getSuffixedFileName, getOutPath, escapeRegExp, fsOperationWithRetry } from '../util';
import { getNumDigits } from '../segments';

import { captureFrame as ffmpegCaptureFrame, captureFrames as ffmpegCaptureFrames } from '../ffmpeg';

const mime = window.require('mime-types');
const { rename, readdir, writeFile } = window.require('fs/promises');


function getFrameFromVideo(video, format, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  canvas.getContext('2d').drawImage(video, 0, 0);

  const dataUri = canvas.toDataURL(`image/${format}`, quality);

  return dataUriToBuffer(dataUri);
}

export default ({ formatTimecode, treatOutputFileModifiedTimeAsStart }) => {
  const captureFramesRange = useCallback(async ({ customOutDir, filePath, fps, fromTime, toTime, estimatedMaxNumFiles, captureFormat, quality, filter, onProgress, outputTimestamps }) => {
    const getSuffix = (prefix) => `${prefix}.${captureFormat}`;

    if (!outputTimestamps) {
      const numDigits = getNumDigits(estimatedMaxNumFiles);
      const nameTemplateSuffix = getSuffix(`%0${numDigits}d`);
      const nameSuffix = getSuffix(`${'1'.padStart(numDigits, '0')}`); // mimic ffmpeg output
      const outPathTemplate = getSuffixedOutPath({ customOutDir, filePath, nameSuffix: nameTemplateSuffix });
      const firstFileOutPath = getSuffixedOutPath({ customOutDir, filePath, nameSuffix });

      await ffmpegCaptureFrames({ from: fromTime, to: toTime, videoPath: filePath, outPathTemplate, captureFormat, quality, filter, onProgress });

      return firstFileOutPath;
    }

    // see https://github.com/mifi/lossless-cut/issues/1139
    const tmpSuffix = 'llc-tmp-frame-capture-';
    const outPathTemplate = getSuffixedOutPath({ customOutDir, filePath, nameSuffix: getSuffix(`${tmpSuffix}%d`) });
    await ffmpegCaptureFrames({ from: fromTime, to: toTime, videoPath: filePath, outPathTemplate, captureFormat, quality, filter, framePts: true, onProgress });

    const outDir = getOutDir(customOutDir, filePath);
    const files = await readdir(outDir);

    // https://github.com/mifi/lossless-cut/issues/1139
    const matches = files.map((fileName) => {
      const escapedRegexp = escapeRegExp(getSuffixedFileName(filePath, tmpSuffix));
      const regexp = `^${escapedRegexp}(\\d+)`;
      const match = fileName.match(new RegExp(regexp));
      if (!match) return undefined;
      const frameNum = parseInt(match[1], 10);
      if (Number.isNaN(frameNum) || frameNum < 0) return undefined;
      return { fileName, frameNum };
    }).filter((it) => it != null);

    console.log('Renaming temp files...');
    const outPaths = await pMap(matches, async ({ fileName, frameNum }) => {
      const duration = formatTimecode({ seconds: fromTime + (frameNum / fps), fileNameFriendly: true });
      const renameFromPath = getOutPath({ customOutDir, filePath, fileName });
      const renameToPath = getOutPath({ customOutDir, filePath, fileName: getSuffixedFileName(filePath, getSuffix(duration, captureFormat)) });
      await fsOperationWithRetry(async () => rename(renameFromPath, renameToPath));
      return renameToPath;
    }, { concurrency: 1 });

    return outPaths[0];
  }, [formatTimecode]);

  const captureFrameFromFfmpeg = useCallback(async ({ customOutDir, filePath, fromTime, captureFormat, quality }) => {
    const time = formatTimecode({ seconds: fromTime, fileNameFriendly: true });
    const nameSuffix = `${time}.${captureFormat}`;
    const outPath = getSuffixedOutPath({ customOutDir, filePath, nameSuffix });
    await ffmpegCaptureFrame({ timestamp: fromTime, videoPath: filePath, outPath, quality });

    await transferTimestamps({ inPath: filePath, outPath, cutFrom: fromTime, treatOutputFileModifiedTimeAsStart });
    return outPath;
  }, [formatTimecode, treatOutputFileModifiedTimeAsStart]);

  const captureFrameFromTag = useCallback(async ({ customOutDir, filePath, currentTime, captureFormat, video, quality }) => {
    const buf = getFrameFromVideo(video, captureFormat, quality);

    const ext = mime.extension(buf.type);
    const time = formatTimecode({ seconds: currentTime, fileNameFriendly: true });

    const outPath = getSuffixedOutPath({ customOutDir, filePath, nameSuffix: `${time}.${ext}` });
    await writeFile(outPath, buf);

    await transferTimestamps({ inPath: filePath, outPath, cutFrom: currentTime, treatOutputFileModifiedTimeAsStart });
    return outPath;
  }, [formatTimecode, treatOutputFileModifiedTimeAsStart]);

  return {
    captureFramesRange,
    captureFrameFromFfmpeg,
    captureFrameFromTag,
  };
};
