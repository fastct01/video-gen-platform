import { spawn } from 'node:child_process';

export class FfmpegError extends Error {}

/** Runs a binary, rejects with the stderr tail on non-zero exit or timeout. */
export function run(bin: string, args: string[], timeoutMs = 30 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => {
      err += d;
      if (err.length > 20_000) err = err.slice(-10_000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new FfmpegError(`${bin} failed to start: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new FfmpegError(`${bin} exited ${code ?? signal}: ${err.slice(-2000)}`));
    });
  });
}

export interface ProbeInfo {
  durationS: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export async function probe(file: string): Promise<ProbeInfo> {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60_000);
  const j = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; duration?: string; avg_frame_rate?: string }[];
  };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  if (!v || !v.width || !v.height) throw new FfmpegError(`no video stream in ${file}`);
  const durationS = Number(v.duration ?? j.format?.duration ?? 0);
  if (!(durationS > 0)) throw new FfmpegError(`could not read duration of ${file}`);
  const [n, d] = (v.avg_frame_rate ?? '0/1').split('/').map(Number);
  return {
    durationS,
    width: v.width,
    height: v.height,
    fps: n && d ? n / d : 0,
    hasAudio: Boolean(j.streams?.some((s) => s.codec_type === 'audio')),
  };
}

/** Writes the very last decodable frame of a clip as a high-quality JPEG. */
export async function extractLastFrame(input: string, outJpg: string): Promise<void> {
  // -sseof seeks near the end; -update 1 keeps overwriting the image so the final frame wins.
  await run('ffmpeg', ['-y', '-v', 'error', '-sseof', '-1', '-i', input, '-update', '1', '-q:v', '2', outJpg], 120_000);
}

export interface StitchInput {
  path: string;
  durationS: number;
  hasAudio: boolean;
}

export interface StitchOptions {
  width: number;
  height: number;
  fps: number;
  /** Seconds of crossfade at each seam. 0 = hard cut (duplicated first frame dropped instead). */
  crossfadeS: number;
}

/**
 * Builds the -filter_complex graph that joins all segments.
 * Every input is normalized (size, SAR, fps, pixel format, timebase) because xfade/concat require
 * identical stream parameters. Clips without audio get silence so the audio track never drifts.
 * Exported separately so it can be unit tested.
 */
export function buildStitchFilter(inputs: StitchInput[], o: StitchOptions): { filter: string; hasAudio: boolean; durationS: number } {
  if (inputs.length === 0) throw new Error('nothing to stitch');
  const anyAudio = inputs.some((i) => i.hasAudio);
  const frame = 1 / o.fps;
  const fade = inputs.length > 1 ? Math.min(o.crossfadeS, ...inputs.map((i) => i.durationS / 3)) : 0;
  const parts: string[] = [];
  const durs: number[] = [];

  inputs.forEach((inp, i) => {
    // With a hard cut, segment i>0 starts on (nearly) the same frame segment i-1 ended on: drop it.
    const trimStart = fade === 0 && i > 0 ? frame : 0;
    const dur = Math.max(frame, inp.durationS - trimStart);
    durs.push(dur);
    const vTrim = trimStart > 0 ? `trim=start=${trimStart.toFixed(4)},setpts=PTS-STARTPTS,` : '';
    parts.push(
      `[${i}:v]fps=${o.fps},${vTrim}scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,` +
        `pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,settb=AVTB[v${i}]`,
    );
    if (anyAudio) {
      const src = inp.hasAudio
        ? `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          (trimStart > 0 ? `atrim=start=${trimStart.toFixed(4)},` : '') +
          `asetpts=PTS-STARTPTS,apad,atrim=duration=${dur.toFixed(4)}`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${dur.toFixed(4)}`;
      parts.push(`${src}[a${i}]`);
    }
  });

  let total: number;
  if (fade === 0) {
    const ins = inputs.map((_, i) => `[v${i}]` + (anyAudio ? `[a${i}]` : '')).join('');
    parts.push(`${ins}concat=n=${inputs.length}:v=1:a=${anyAudio ? 1 : 0}[vout]${anyAudio ? '[aout]' : ''}`);
    total = durs.reduce((a, b) => a + b, 0);
  } else {
    let vPrev = 'v0';
    let aPrev = 'a0';
    let acc = durs[0]!;
    for (let k = 1; k < inputs.length; k++) {
      const vOut = k === inputs.length - 1 ? 'vout' : `vx${k}`;
      const aOut = k === inputs.length - 1 ? 'aout' : `ax${k}`;
      parts.push(`[${vPrev}][v${k}]xfade=transition=fade:duration=${fade.toFixed(4)}:offset=${(acc - fade).toFixed(4)}[${vOut}]`);
      if (anyAudio) parts.push(`[${aPrev}][a${k}]acrossfade=d=${fade.toFixed(4)}[${aOut}]`);
      vPrev = vOut;
      aPrev = aOut;
      acc += durs[k]! - fade;
    }
    total = acc;
  }
  return { filter: parts.join(';'), hasAudio: anyAudio, durationS: total };
}

export async function stitch(inputs: StitchInput[], output: string, o: StitchOptions): Promise<{ durationS: number }> {
  const { filter, hasAudio, durationS } = buildStitchFilter(inputs, o);
  const args = ['-y', '-v', 'error'];
  for (const i of inputs) args.push('-i', i.path);
  args.push('-filter_complex', filter, '-map', '[vout]');
  if (hasAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output);
  await run('ffmpeg', args, Math.max(10 * 60_000, inputs.length * 60_000));
  return { durationS };
}
