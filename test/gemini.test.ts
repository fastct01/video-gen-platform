import { describe, expect, it } from 'vitest';
import { extractText, extractVideo, parseFileId } from '../src/providers/gemini.js';

describe('gemini response parsing', () => {
  it('finds a uri video in model_output steps', () => {
    const res = {
      id: 'v1_x',
      status: 'completed',
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'a cat' }] },
        { type: 'thought', content: [] },
        { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123' }] },
      ],
    };
    expect(extractVideo(res)).toEqual({ data: undefined, uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123' });
  });
  it('finds inline data and ignores user input', () => {
    const res = { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }, { type: 'video', data: 'AAAA' }] }] };
    expect(extractVideo(res)?.data).toBe('AAAA');
  });
  it('returns null and surfaces text when the model refused', () => {
    const res = { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot generate that.' }] }] };
    expect(extractVideo(res)).toBeNull();
    expect(extractText(res)).toContain('cannot');
  });
  it('parses file ids', () => {
    expect(parseFileId('https://x/v1beta/files/abc-1:download?alt=media')).toBe('abc-1');
    expect(parseFileId('files/zzz')).toBe('zzz');
    expect(parseFileId('https://example.com/video.mp4')).toBeNull();
  });
});

describe('GeminiProvider request', () => {
  it('sends store=true whenever delivery is "uri" (the API rejects store=false with uri delivery)', async () => {
    const { createServer } = await import('node:http');
    const { GeminiProvider } = await import('../src/providers/gemini.js');
    let body: any;
    let key: string | undefined;
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        body = JSON.parse(raw);
        key = String(req.headers['x-goog-api-key']);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'completed', outputs: [{ type: 'video', data: Buffer.from('mp4').toString('base64') }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const p = new GeminiProvider({ apiKey: 'AIza-test', model: 'm', baseUrl: `http://127.0.0.1:${port}`, tokensPerSecond: 0, requestTimeoutMs: 10_000 });
      const r = await p.generate({ prompt: 'x', durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' } as any);
      expect(r.state).toBe('completed');
      expect(key).toBe('AIza-test');
      expect(body.response_format.delivery).toBe('uri');
      expect(body.store).toBe(true);
    } finally {
      server.close();
    }
  });
});
