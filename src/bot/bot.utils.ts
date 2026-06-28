import { BadRequestException } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import {
  EMBEDDING_DIMENSIONS,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  MAX_TRAINING_PDF_BYTES,
  MIN_TRAINING_TEXT_LENGTH,
  TrainingPdfFile,
} from './bot.types';

export function cleanTrainingText(value: string) {
  return value
    .replaceAll('\u0000', '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseBooleanLike(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' || value === '') return undefined;
  return !['false', '0', 'no', 'off'].includes(value.toLowerCase());
}

export function parseNumberLike(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(next)));
}

export function chunkText(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  chunkOverlap = DEFAULT_CHUNK_OVERLAP,
) {
  const normalized = cleanTrainingText(text).replace(/\s+/g, ' ');
  if (!normalized) return [];
  if (normalized.length <= chunkSize) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const hardEnd = Math.min(start + chunkSize, normalized.length);
    const softEnd = findChunkEnd(normalized, start, hardEnd);
    chunks.push(normalized.slice(start, softEnd).trim());
    if (softEnd >= normalized.length) break;
    start = Math.max(softEnd - chunkOverlap, start + 1);
  }
  return chunks.filter(Boolean);
}

function findChunkEnd(text: string, start: number, hardEnd: number) {
  if (hardEnd >= text.length) return text.length;
  const slice = text.slice(start, hardEnd);
  const sentenceEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('! '),
  );
  if (sentenceEnd > hardEnd - start - 260) return start + sentenceEnd + 1;
  const space = slice.lastIndexOf(' ');
  return space > 120 ? start + space : hardEnd;
}

function hashToken(token: string) {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function embedLocally(text: string, dimensions = EMBEDDING_DIMENSIONS) {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);

  for (const token of tokens) {
    vector[hashToken(token) % dimensions] += 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm ? vector.map((value) => value / norm) : vector;
}

export function cosineSimilarity(a: number[], b: number[]) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) {
    return 0;
  }
  const dimensions = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < dimensions; i++) dot += a[i] * b[i];
  return dot;
}

export async function extractPdfTrainingText(file?: TrainingPdfFile) {
  if (!file) throw new BadRequestException('No PDF file provided');
  const originalName = file.originalname || '';
  const isPdf =
    file.mimetype === 'application/pdf' ||
    originalName.toLowerCase().endsWith('.pdf');
  if (!isPdf) throw new BadRequestException('Training file must be a PDF');
  if (file.size > MAX_TRAINING_PDF_BYTES) {
    throw new BadRequestException('Training PDF must be 8 MB or smaller');
  }

  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: file.buffer });
    const parsed = await parser.getText();
    const text = cleanTrainingText(parsed.text || '');
    if (text.length < MIN_TRAINING_TEXT_LENGTH) {
      throw new BadRequestException(
        'We could not read enough text from this PDF. Try exporting it as a text-based PDF.',
      );
    }
    return { text, pages: parsed.total || 0, characters: text.length };
  } catch (error: any) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(
      error.message || 'We could not read that PDF. Please try another file.',
    );
  } finally {
    await parser?.destroy();
  }
}

export function summarizeSnippet(value: string, maxLength = 320) {
  const clean = cleanTrainingText(value).replace(/\s+/g, ' ');
  return clean.length > maxLength ? `${clean.slice(0, maxLength).trim()}...` : clean;
}
