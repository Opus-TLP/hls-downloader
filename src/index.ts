import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChunksLiveDownloader } from "./ChunksLiveDownloader.js";
import { ChunksStaticDownloader } from "./ChunksStaticDownloader.js";
import { IConfig as IIConfig } from "./Config.js";
import { mergeChunks as mergeChunksFfmpeg, transmuxTsToMp4 } from "./ffmpeg.js";
import { mergeFiles as mergeChunksStream } from "./stream.js";
import { StreamChooser } from "./StreamChooser.js";
import { buildLogger, ILogger } from "./Logger.js";
import { ChunksDownloader } from "./ChunksDownloader.js";

export type IConfig = IIConfig;

export const mkdirp = (dir: string): void => {
    try {
        fs.mkdirSync(dir);
    } catch { /** */ }
};

export const rmrf = (dir: string): void => {
    fs.rmSync(dir, { force: true, recursive: true });
};

export async function download(config: IConfig): Promise<void> {
    const logger: ILogger = buildLogger(config.logger);

    // Temporary files
    const runId = Date.now();
    const mergedSegmentsFile = config.mergedSegmentsFile ||
        os.tmpdir() + "/hls-downloader/" + runId + ".ts";
    const segmentsDir = config.segmentsDir ||
        os.tmpdir() + "/hls-downloader/" + runId + "/";
    const ffmpegPath = config.ffmpegPath || "ffmpeg";

    // Create target directory
    mkdirp(path.dirname(mergedSegmentsFile));
    mkdirp(segmentsDir);

    // Choose proper stream
    const streamChooser = new StreamChooser(
        logger,
        config.streamUrl,
        config.httpHeaders,
    );
    if (!await streamChooser.load()) {
        return;
    }
    const playlistUrl = streamChooser.getPlaylistUrl(config.quality);
    if (!playlistUrl) {
        return;
    }

    // Start download
    const chunksDownloader: ChunksDownloader = config.live
        ? new ChunksLiveDownloader(
            logger,
            playlistUrl,
            config.concurrency || 1,
            config.maxRetries || 1,
            config.fromEnd || 9999,
            segmentsDir,
            undefined,
            undefined,
            config.httpHeaders,
        )
        : new ChunksStaticDownloader(
            logger,
            playlistUrl,
            config.concurrency || 1,
            config.maxRetries || 1,
            segmentsDir,
            config.httpHeaders,
        );
    await chunksDownloader.start();

    // Get all segments
    const segments = fs.readdirSync(segmentsDir).map((f) => segmentsDir + f);
    segments.sort((a: string, b: string) => {
        return a.localeCompare(b, undefined, {
            numeric: true,
            sensitivity: "base",
        });
    });

    // Merge TS files
    const mergeFunction = config.mergeUsingFfmpeg
        ? (segments: string[], merged: string) =>
            mergeChunksFfmpeg(logger, ffmpegPath, segments, merged)
        : mergeChunksStream;
    await mergeFunction(segments, mergedSegmentsFile);

    // Transmux
    await transmuxTsToMp4(
        logger,
        ffmpegPath,
        mergedSegmentsFile,
        config.outputFile,
    );

    // Delete temporary files
    rmrf(segmentsDir);
    rmrf(mergedSegmentsFile);
}
