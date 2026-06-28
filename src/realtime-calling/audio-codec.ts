const BIAS = 0x84;
const CLIP = 32635;

export function decodeUlawToPcm16(base64: string) {
  const ulaw = Buffer.from(base64, 'base64');
  const pcm = Buffer.alloc(ulaw.length * 2);
  for (let i = 0; i < ulaw.length; i++) {
    pcm.writeInt16LE(ulawByteToLinear(ulaw[i]), i * 2);
  }
  return pcm;
}

export function transcodePcm24kToUlaw8k(pcmBuffer: Buffer) {
  const pcm8k = downsamplePcm16(pcmBuffer, 24000, 8000);
  const out = Buffer.alloc(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) {
    out[i] = linearToUlawByte(pcm8k[i]);
  }
  return out;
}

export function resamplePcm16(
  pcmBuffer: Buffer,
  sourceRate: number,
  targetRate: number,
) {
  if (sourceRate === targetRate) return pcmBuffer;
  const source = bufferToInt16(pcmBuffer);
  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.round(source.length / ratio));
  const output = Buffer.alloc(outputLength * 2);

  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const index = Math.floor(sourceIndex);
    const fraction = sourceIndex - index;
    const current = source[index] || 0;
    const next = source[Math.min(index + 1, source.length - 1)] || current;
    output.writeInt16LE(
      Math.round(current + (next - current) * fraction),
      i * 2,
    );
  }

  return output;
}

export function calculateDbfs(pcmBuffer: Buffer) {
  if (pcmBuffer.length < 2) return -100;
  let sumSquares = 0;
  const samples = Math.floor(pcmBuffer.length / 2);
  for (let i = 0; i < samples; i++) {
    const sample = pcmBuffer.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / samples);
  return rms === 0 ? -100 : 20 * Math.log10(rms / 32768);
}

function downsamplePcm16(input: Buffer, sourceRate: number, targetRate: number) {
  if (sourceRate === targetRate) return bufferToInt16(input);
  const source = bufferToInt16(input);
  const ratio = sourceRate / targetRate;
  const outputLength = Math.floor(source.length / ratio);
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), source.length);
    let total = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      total += source[j];
      count++;
    }
    output[i] = count ? Math.round(total / count) : source[start] || 0;
  }
  return output;
}

function bufferToInt16(input: Buffer) {
  const out = new Int16Array(Math.floor(input.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = input.readInt16LE(i * 2);
  return out;
}

function linearToUlawByte(sample: number) {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  for (
    let expMask = 0x4000;
    (sample & expMask) === 0 && exponent > 0;
    expMask >>= 1
  ) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function ulawByteToLinear(value: number) {
  value = ~value & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign ? -sample : sample;
}
