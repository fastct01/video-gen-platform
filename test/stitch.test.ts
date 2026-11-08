import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStitchFilter, extractLastFrame, probe, run, stitch } from '../src/media/ffmpeg.js';

let dir: string;
const clip = async (name: string, seconds: number, audio: boolean, size = '320x180') => {
  const p = path.join(dir, name);
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-t', String(seconds), '-i', `testsrc2=size=${size}:rate=24`];
  if (audio) args.push('-f', 'lavfi', '-t', String(seconds), '-i', 'sine=frequency=440:sample_rate=44100');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', ...(audio ? ['-c:a', 'aac'] : []), p);
  await run('ffmpeg', args);
  return p;
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'stitch-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('buildStitchFilter', () => {
  const inputs = [
    { path: 'a', durationS: 5, hasAudio: true },
    { path: 'b', durationS: 5, hasAudio: false },
    { path: 'c', durationS: 4, hasAudio: true },
  ];
  it('chains xfade/acrossfade with offsets that account for overlap', () => {
    const { filter, durationS } = buildStitchFilter(inputs, { width: 320, height: 180, fps: 24, crossfadeS: 0.5 });
    expect(filter).toContain('xfade=transition=fade:duration=0.5000:offset=4.5000[vx1]');
    expect(filter).toContain('xfade=transition=fade:duration=0.5000:offset=9.0000[vout]');
    expect(filter).toContain('anullsrc'); // clip b has no audio -> silence
    expect(durationS).toBeCloseTo(13);
  });
  it('hard cut drops the duplicated first frame of later segments', () => {
    const { filter } = buildStitchFilter(inputs, { width: 320, height: 180, fps: 24, crossfadeS: 0 });
    expect(filter).toContain('concat=n=3:v=1:a=1[vout][aout]');
    expect(filter.match(/fps=24,trim=start=0\.0417/g)?.length).toBe(2);
  });
  it('omits audio when no segment has any', () => {
    const { filter, hasAudio } = buildStitchFilter(
      inputs.map((i) => ({ ...i, hasAudio: false })),
      { width: 320, height: 180, fps: 24, crossfadeS: 0.2 },
    );
    expect(hasAudio).toBe(false);
    expect(filter).not.toContain('[a0]');
  });
});

describe('ffmpeg integration', () => {
  it('stitches mixed clips (audio/no audio, different sizes) with crossfade', async () => {
    const a = await clip('a.mp4', 2, true);
    const b = await clip('b.mp4', 2, false, '640x360');
    const c = await clip('c.mp4', 2, true);
    const out = path.join(dir, 'out.mp4');
    const inputs = await Promise.all([a, b, c].map(async (p) => ({ path: p, ...(await probe(p)) })));
    const res = await stitch(inputs, out, { width: 320, height: 180, fps: 24, crossfadeS: 0.2 });
    const info = await probe(out);
    expect(info.width).toBe(320);
    expect(info.hasAudio).toBe(true);
    expect(info.durationS).toBeCloseTo(res.durationS, 0);
  });

  it('stitches a single clip and extracts a last frame', async () => {
    const a = await clip('single.mp4', 1, false);
    const out = path.join(dir, 'single-out.mp4');
    await stitch([{ path: a, durationS: 1, hasAudio: false }], out, { width: 320, height: 180, fps: 24, crossfadeS: 0.2 });
    expect((await probe(out)).hasAudio).toBe(false);
    const jpg = path.join(dir, 'last.jpg');
    await extractLastFrame(out, jpg);
    const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', jpg]);
    expect(r.trim()).toBe('320');
  });
});
