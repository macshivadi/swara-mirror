import { readFileSync } from 'node:fs';

export interface WavPcm {
  sampleRate: number;
  samples: Float32Array;
}

/** Minimal PCM WAV reader (16-bit or 32-bit float, mono or mixdown). */
export function readWavFile(path: string): WavPcm {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Not a RIFF/WAVE file: ${path}`);
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  let format = 1;
  let dataOff = -1;
  let dataLen = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(start);
      channels = buf.readUInt16LE(start + 2);
      sampleRate = buf.readUInt32LE(start + 4);
      bits = buf.readUInt16LE(start + 14);
    } else if (id === 'data') {
      dataOff = start;
      dataLen = size;
      break;
    }
    offset = start + size + (size % 2);
  }
  if (dataOff < 0 || !sampleRate) throw new Error(`Invalid WAV: ${path}`);
  const bytes = bits / 8;
  const frames = Math.floor(dataLen / (bytes * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = dataOff + (i * channels + c) * bytes;
      if (format === 3 && bits === 32) acc += buf.readFloatLE(p);
      else if (bits === 16) acc += buf.readInt16LE(p) / 32768;
      else if (bits === 8) acc += (buf[p]! - 128) / 128;
      else if (bits === 24) {
        const v = buf[p]! | (buf[p + 1]! << 8) | (buf[p + 2]! << 16);
        const signed = v & 0x800000 ? v - 0x1000000 : v;
        acc += signed / 8388608;
      } else throw new Error(`Unsupported WAV format ${format}/${bits} in ${path}`);
    }
    samples[i] = acc / channels;
  }
  return { sampleRate, samples };
}
