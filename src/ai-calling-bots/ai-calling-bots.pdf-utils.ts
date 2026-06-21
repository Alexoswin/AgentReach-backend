import { BadRequestException } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import { TrainingPdfFile } from './ai-calling-bots.constants';
import { cleanTrainingText } from './ai-calling-bots.training-utils';

export async function extractPdfTrainingText(
  file: TrainingPdfFile,
  maxBytes: number,
  minTextLength: number,
) {
  if (!file) {
    throw new BadRequestException('No PDF file provided');
  }

  const originalName = file.originalname || '';
  const isPdf =
    file.mimetype === 'application/pdf' ||
    originalName.toLowerCase().endsWith('.pdf');
  if (!isPdf) {
    throw new BadRequestException('Training file must be a PDF');
  }

  if (file.size > maxBytes) {
    throw new BadRequestException('Training PDF must be 8 MB or smaller');
  }

  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: file.buffer });
    const parsed = await parser.getText();
    const text = cleanTrainingText(parsed.text || '');

    if (text.length < minTextLength) {
      throw new BadRequestException(
        'We could not read enough text from this PDF. Try exporting it as a text-based PDF.',
      );
    }

    return {
      text,
      characters: text.length,
      pages: parsed.total || 0,
    };
  } catch (error: any) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(
      error.message || 'We could not read that PDF. Please try another file.',
    );
  } finally {
    await parser?.destroy();
  }
}
