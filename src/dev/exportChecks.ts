/**
 * In-browser export checks with the real pieces: Mediabunny, the browser's encoders, WebGL and
 * a real FileSystemWritableFileStream. The file lives in the origin-private file system
 * (OPFS) — never in the user's folders. Development builds only:
 *
 *   await __beatform.checks.runExportChecks()
 */
import { getCurrentFile } from '../audio/controller';
import { qualityProfile } from '../engine/quality';
import { loadMediabunny } from '../export/capabilities';
import { videoBitrate, type ExportSpec } from '../export/plan';
import { ExportCancelledError, RenderController, type RenderJob } from '../export/RenderController';
import { OutputLimitError, TransactionalFileSink } from '../export/sinks';
import { usePlayer } from '../state/player';
import { snapshotForExport } from '../export/studio';

const ORIGINAL = 'ORIGINAL FILE CONTENTS'; // 22 bytes, as in the review
const FILE_NAME = 'beatform-export-check.mp4';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function opfsFile(): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getFileHandle(FILE_NAME, { create: true });
}

async function writeOriginal(handle: FileSystemFileHandle): Promise<void> {
  const w = await handle.createWritable();
  await w.write(ORIGINAL);
  await w.close();
}

async function readText(handle: FileSystemFileHandle): Promise<string> {
  return (await handle.getFile()).text();
}

function spec(over: Partial<ExportSpec> = {}): ExportSpec {
  const base: ExportSpec = {
    container: 'mp4',
    videoCodec: 'avc',
    audioCodec: 'aac',
    width: 640,
    height: 360,
    fps: 30,
    quality: 'standard',
    videoBitrate: 0,
    audioBitrate: 192000,
    start: 2.95,
    end: 4.95,
    ...over,
  };
  base.videoBitrate = videoBitrate(base.videoCodec, base.width, base.height, base.fps, base.quality);
  return base;
}

function job(file: File, s: ExportSpec, extra: Partial<RenderJob> = {}): RenderJob {
  return {
    spec: s,
    file,
    eventMap: usePlayer.getState().analysis?.events ?? null,
    visual: snapshotForExport(),
    quality: qualityProfile('balanced'),
    fftSize: 2048,
    reducedMotion: false,
    ...extra,
  };
}

async function describeFile(blob: Blob) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    return {
      format: (await input.getFormat()).name,
      duration: await input.computeDuration(),
      videoCodec: video?.codec ?? null,
      videoPackets: video ? (await video.computePacketStats()).packetCount : 0,
      audioCodec: audio?.codec ?? null,
      audioChannels: audio?.numberOfChannels ?? 0,
    };
  } finally {
    input.dispose();
  }
}

export async function runExportChecks(): Promise<CheckResult[]> {
  const track = getCurrentFile();
  if (!track) throw new Error('Load the TEST PATTERN first');
  const results: CheckResult[] = [];
  const record = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });
  const handle = await opfsFile();

  // 1 — cancel while rendering
  await writeOriginal(handle);
  {
    const c = new RenderController(job(track, spec(), { disk: new TransactionalFileSink(await handle.createWritable()) }), (p) => {
      if (p.phase === 'rendering' && p.frame >= 16) c.cancel();
    });
    const err = await c.run().then(() => null, (e: unknown) => e);
    const text = await readText(handle);
    record('disk: cancel while rendering keeps the existing file', err instanceof ExportCancelledError && text === ORIGINAL, `error=${(err as Error)?.name}, file=${JSON.stringify(text)} (${text.length} B)`);
  }

  // 2 — cancel during finalizing
  await writeOriginal(handle);
  {
    let finalizing = false;
    const c = new RenderController(job(track, spec(), { disk: new TransactionalFileSink(await handle.createWritable()) }), (p) => {
      if (p.phase === 'finalizing') {
        finalizing = true;
        c.cancel();
      }
    });
    const err = await c.run().then(() => null, (e: unknown) => e);
    const text = await readText(handle);
    record('disk: cancel during finalizing keeps the existing file', finalizing && err instanceof ExportCancelledError && text === ORIGINAL, `reached finalizing=${finalizing}, error=${(err as Error)?.name}, file=${JSON.stringify(text)}`);
  }

  // 3 — a decode error after the file was opened
  await writeOriginal(handle);
  {
    const garbage = new File([crypto.getRandomValues(new Uint8Array(4096))], 'garbage.mp3', { type: 'audio/mpeg' });
    const err = await new RenderController(job(garbage, spec(), { disk: new TransactionalFileSink(await handle.createWritable()) })).run().then(
      () => null,
      (e: unknown) => e,
    );
    const text = await readText(handle);
    record('disk: an error keeps the existing file', err instanceof Error && !(err instanceof ExportCancelledError) && text === ORIGINAL, `error=${(err as Error)?.message?.slice(0, 80)}, file=${JSON.stringify(text)}`);
  }

  // 4 — a configuration the muxer rejects (before any frame): H.264 cannot go into WebM
  await writeOriginal(handle);
  {
    const err = await new RenderController(job(track, spec({ container: 'webm', audioCodec: 'opus' }), { disk: new TransactionalFileSink(await handle.createWritable()) })).run().then(
      () => null,
      (e: unknown) => e,
    );
    const text = await readText(handle);
    record("disk: a rejected configuration keeps the existing file", err instanceof Error && text === ORIGINAL, `error=${(err as Error)?.message?.slice(0, 80)}, file=${JSON.stringify(text.slice(0, 40))} (${text.length} B)`);
  }

  // 5 — success replaces the file with a complete video
  await writeOriginal(handle);
  {
    const phases: string[] = [];
    const r = await new RenderController(job(track, spec(), { disk: new TransactionalFileSink(await handle.createWritable()) }), (p) => phases.push(p.phase)).run();
    const file = await handle.getFile();
    const info = await describeFile(file);
    // the fast-start header reserves room for the maximum packet count, so look past it
    const head = new TextDecoder('latin1').decode(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()));
    const ok = file.size > 10_000 && info.videoPackets === 60 && info.audioCodec === 'aac' && Math.abs(info.duration - 2) < 0.05 && head.indexOf('moov') >= 0 && head.indexOf('moov') < head.indexOf('mdat');
    record('disk: a successful export replaces the file at the end', ok && phases.at(-1) === 'saving' && r.frames === 60, `${file.size} B, ${JSON.stringify(info)}, fast start=${head.indexOf('moov') >= 0}, last phase=${phases.at(-1)}`);
  }

  // 6 — in-memory limit enforced on real data while rendering (the muxer hands data over two
  // 256 KB chunks behind, so the stop comes within that margin of the limit)
  {
    let lastFrame = 0;
    let finalized = false;
    const limit = 1024 * 1024;
    const err = await new RenderController(job(track, spec({ start: 0, end: 20 }), { memoryLimitBytes: limit }), (p) => {
      if (p.phase === 'rendering') lastFrame = p.frame;
      if (p.phase === 'finalizing') finalized = true;
    })
      .run()
      .then(
        () => null,
        (e: unknown) => e,
      );
    record('memory: the real size limit stops the export while rendering', err instanceof OutputLimitError && !finalized && lastFrame < 600, `error=${(err as Error)?.message}, stopped near frame ${lastFrame} of 600, reached finalize=${finalized}`);
  }

  // 7 — in-memory success: the size grows while rendering; the result is complete
  {
    const sizes: number[] = [];
    const r = await new RenderController(job(track, spec({ start: 2.95, end: 10.95 })), (p) => {
      if (p.phase === 'rendering') sizes.push(p.bytes);
    }).run();
    const info = await describeFile(r.blob!);
    const grew = sizes.filter((b) => b > 0).length >= 3 && sizes.at(-1)! > sizes.find((b) => b > 0)!;
    record('memory: size is counted while rendering; result is complete', grew && info.videoPackets === 240 && r.bytes === r.blob!.size, `sizes while rendering=${sizes.join(',')}, result=${r.bytes} B, ${JSON.stringify(info)}`);
  }

  await (await navigator.storage.getDirectory()).removeEntry(FILE_NAME);
  return results;
}
