import { Injectable, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MongoService } from '../mongo.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { GenerateTemplateDto } from './dto/generate-template.dto';
import { GoogleGenAI } from '@google/genai';
import { resolveGeminiTextModel } from '../config/gemini-text';
import { SettingsService } from '../settings/settings.service';
import type { PDFParse } from 'pdf-parse';

const MAX_TEMPLATE_ATTACHMENTS = 5;
const MAX_TEMPLATE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
// Every attachment is stored base64-encoded inside the Template document and
// re-encoded into the MIME payload at send time. Both ends have hard ceilings:
// MongoDB rejects documents over 16 MB, and SES rejects raw messages over
// 10 MB. Base64 inflates bytes by ~4/3, so the decoded total has to stay well
// under both. 7 MB decoded ≈ 9.4 MB on the wire, which clears SES with room
// for headers and the body parts.
const MAX_TEMPLATE_ATTACHMENTS_TOTAL_BYTES = 7 * 1024 * 1024;
const MAX_REFERENCE_PDF_BYTES = 8 * 1024 * 1024;

type TemplateGenerationJob = {
  id: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  result?: {
    subject: string;
    bodyHtml: string;
    bodyText: string;
  };
  error?: string;
  createdAt: string;
  updatedAt: string;
  // Generated with this user's Gemini key; only they can read the result.
  userId: string;
};

@Injectable()
export class TemplatesService {
  private generationJobs = new Map<string, TemplateGenerationJob>();

  constructor(
    private db: MongoService,
    private settingsService: SettingsService,
  ) {}

  async findAll() {
    return this.db.template.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const template = await this.db.template.findUnique({
      where: { id },
    });
    if (!template) {
      throw new BadRequestException('Template not found');
    }
    return template;
  }

  async create(dto: CreateTemplateDto) {
    const data = this.normalizeTemplate(dto);

    return this.db.template.create({
      data,
    });
  }

  async update(id: string, dto: Partial<CreateTemplateDto>) {
    await this.findOne(id);
    const data = this.normalizeTemplate(dto, false);

    return this.db.template.update({
      where: { id },
      data,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.db.template.delete({
      where: { id },
    });
  }

  async parseReferencePdf(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No PDF file provided');
    }

    const isPdf =
      file.mimetype === 'application/pdf' ||
      file.originalname.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      throw new BadRequestException('Reference file must be a PDF');
    }

    if (file.size > MAX_REFERENCE_PDF_BYTES) {
      throw new BadRequestException('Reference PDF must be 8 MB or smaller');
    }

    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: file.buffer });
    try {
      const parsed = await parser.getText();
      const text = this.cleanReferenceText(parsed.text || '');

      if (text.length < 40) {
        throw new BadRequestException(
          'We could not read enough text from this PDF. Try exporting it as a text-based PDF.',
        );
      }

      return {
        name: file.originalname,
        text: text.slice(0, 12000),
        characters: text.length,
        pages: parsed.total || 0,
      };
    } catch (error: any) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        error.message || 'We could not read that PDF. Please try another file.',
      );
    } finally {
      await parser.destroy();
    }
  }

  startAiTemplateGeneration(dto: GenerateTemplateDto, userId: string) {
    const now = new Date().toISOString();
    const job: TemplateGenerationJob = {
      id: randomUUID(),
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      userId,
    };

    this.generationJobs.set(job.id, job);

    void this.runTemplateGenerationJob(job.id, dto, userId);

    return job;
  }

  getAiTemplateGenerationStatus(id: string, userId: string) {
    const job = this.generationJobs.get(id);
    if (!job || job.userId !== userId) {
      throw new BadRequestException('Template generation job not found');
    }
    return job;
  }

  getPredefinedTemplates() {
    return [
      {
        id: 'predefined-job-app',
        name: 'Standard Job Application',
        category: 'Job Application',
        subject: 'Application for {{jobTitle}} - {{firstName}} {{lastName}}',
        bodyText:
          'Dear hiring team at {{company}},\n\nI am writing to express my interest in the {{jobTitle}} position at your company. With my background in software engineering, I am confident I can make an immediate contribution to your team.\n\nBest regards,\n{{lastName}}',
        bodyHtml:
          '<p>Dear hiring team at {{company}},</p><p>I am writing to express my interest in the <strong>{{jobTitle}}</strong> position at your company. With my background in software engineering, I am confident I can make an immediate contribution to your team.</p><p>Best regards,<br/>{{lastName}}</p>',
        type: 'PREDEFINED',
      },
      {
        id: 'predefined-recruiter',
        name: 'Recruiter Outreach',
        category: 'Recruiter Outreach',
        subject: 'Experienced {{jobTitle}} open to new roles',
        bodyText:
          'Hi {{firstName}},\n\nI saw that you recruit for {{jobTitle}} roles at {{company}}. I am currently exploring new opportunities and would love to see if my background matches any active roles you are sourcing for.\n\nBest,\n{{lastName}}',
        bodyHtml:
          '<p>Hi {{firstName}},</p><p>I saw that you recruit for <strong>{{jobTitle}}</strong> roles at {{company}}. I am currently exploring new opportunities and would love to see if my background matches any active roles you are sourcing for.</p><p>Best,<br/>{{lastName}}</p>',
        type: 'PREDEFINED',
      },
      {
        id: 'predefined-hiring-manager',
        name: 'Hiring Manager Quick Pitch',
        category: 'Hiring Manager Outreach',
        subject: 'Quick question regarding {{jobTitle}} at {{company}}',
        bodyText:
          'Hi {{firstName}},\n\nI saw you lead the engineering team at {{company}}. I noticed you are hiring a {{jobTitle}} and wanted to reach out directly to highlight my experience with systems design and React.\n\nWould you be open to a quick 5-minute chat next week?\n\nThanks,\n{{lastName}}',
        bodyHtml:
          '<p>Hi {{firstName}},</p><p>I saw you lead the engineering team at {{company}}. I noticed you are hiring a <strong>{{jobTitle}}</strong> and wanted to reach out directly to highlight my experience with systems design and React.</p><p>Would you be open to a quick 5-minute chat next week?</p><p>Thanks,<br/>{{lastName}}</p>',
        type: 'PREDEFINED',
      },
      {
        id: 'predefined-networking',
        name: 'Informational Interview Request',
        category: 'Networking',
        subject: 'Learning from your career path at {{company}}',
        bodyText:
          'Hi {{firstName}},\n\nI came across your profile and was very impressed by your journey as a {{jobTitle}} at {{company}}. I am looking to grow my career in the same space and would love to buy you a virtual coffee to ask a few questions about your career path.\n\nSincerely,\n{{lastName}}',
        bodyHtml:
          '<p>Hi {{firstName}},</p><p>I came across your profile and was very impressed by your journey as a <strong>{{jobTitle}}</strong> at {{company}}. I am looking to grow my career in the same space and would love to buy you a virtual coffee to ask a few questions about your career path.</p><p>Sincerely,<br/>{{lastName}}</p>',
        type: 'PREDEFINED',
      },
      {
        id: 'predefined-follow-up',
        name: 'Follow Up After Application',
        category: 'Follow Up',
        subject: 'Following up on application: {{jobTitle}} role',
        bodyText:
          'Hi {{firstName}},\n\nI hope you are having a great week. I wanted to follow up on the {{jobTitle}} role at {{company}} that I applied for last week. I remain highly interested and wanted to see if you have any updates on the timeline.\n\nWarmly,\n{{lastName}}',
        bodyHtml:
          '<p>Hi {{firstName}},</p><p>I hope you are having a great week. I wanted to follow up on the <strong>{{jobTitle}}</strong> role at {{company}} that I applied for last week. I remain highly interested and wanted to see if you have any updates on the timeline.</p><p>Warmly,<br/>{{lastName}}</p>',
        type: 'PREDEFINED',
      },
      {
        id: 'predefined-partnership',
        name: 'Partnership Outreach',
        category: 'Partnership Outreach',
        subject: 'Exploring synergies between our teams',
        bodyText:
          'Hi {{firstName}},\n\nI hope this email finds you well. As the {{jobTitle}} at {{company}}, I wanted to reach out regarding a potential collaboration. We help companies scale their operations and I believe there is a strong synergy between our offerings.\n\nLet me know if you are open to discussing this.\n\nBest,\n{{lastName}}',
        bodyHtml:
          '<p>Hi {{firstName}},</p><p>I hope this email finds you well. As the <strong>{{jobTitle}}</strong> at {{company}}, I wanted to reach out regarding a potential collaboration. We help companies scale their operations and I believe there is a strong synergy between our offerings.</p><p>Let me know if you are open to discussing this.</p><p>Best,<br/>{{lastName}}</p>',
        type: 'PREDEFINED',
      },
    ];
  }

  async generateAiTemplate(dto: GenerateTemplateDto, userId: string) {
    const format = dto.format === 'TEXT' ? 'TEXT' : 'HTML';
    const referenceContext = this.buildReferenceContext(
      dto.referenceDocumentText,
      dto.referenceDocumentName,
    );
    const settings = await this.settingsService.getRawSettings(userId);

    const hasNoKey = !settings || !settings.geminiApiKey;
    if (hasNoKey) {
      throw new BadRequestException(
        'Gemini API key is not configured. Please set your API key in AI settings.',
      );
    }

    try {
      const bodyInstructions =
        format === 'HTML'
          ? `2. "bodyHtml" - A real HTML email body, not plain text. It must be non-empty and include valid HTML tags such as <div>, <p>, <strong>, <a>, and <br>. Use simple inline styles that work in email clients. Do not wrap it in markdown or code fences.
3. "bodyText" - The plain text fallback equivalent of the HTML body.`
          : `2. "bodyHtml" - Return an empty string.
3. "bodyText" - The plain text email body. Do not include HTML tags.`;

      const prompt = `You are an expert copywriter. Write a highly personalized ${format} outreach email campaign template based on:
Goal: ${dto.goal}
Target Audience: ${dto.audience}
Tone: ${dto.tone}
Special Instructions: ${dto.instructions || 'None'}
${referenceContext ? `\nReference PDF Context${dto.referenceDocumentName ? ` (${dto.referenceDocumentName})` : ''}:\n${referenceContext}\n` : ''}

Variables available for personalization (use them exactly in double curly brackets, e.g. {{firstName}}):
- {{firstName}}
- {{lastName}}
- {{company}}
- {{jobTitle}}
- {{email}}

You MUST return a JSON object with EXACTLY these three fields:
1. "subject" - A catchy, highly relevant subject line.
${bodyInstructions}

Do NOT write any preamble, explanation, or markdown backticks outside of the JSON. Return only the JSON object.`;

      const ai = new GoogleGenAI({ apiKey: settings.geminiApiKey });
      const response = await ai.models.generateContent({
        model: resolveGeminiTextModel(settings.geminiTextModel),
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      });

      const contentString = (response.text || '').trim();
      if (!contentString) {
        throw new Error('Empty response received from Gemini');
      }

      // Handle raw markdown wrappers in response if any
      let cleanedJson = contentString.trim();
      if (cleanedJson.startsWith('```')) {
        cleanedJson = cleanedJson
          .replace(/^```json/, '')
          .replace(/^```/, '')
          .replace(/```$/, '')
          .trim();
      }

      const parsed = JSON.parse(cleanedJson);
      const parsedBodyHtml =
        typeof parsed.bodyHtml === 'string' ? parsed.bodyHtml : '';
      const parsedBodyText =
        typeof parsed.bodyText === 'string' ? parsed.bodyText : '';
      const bodyHtml =
        format === 'HTML'
          ? this.ensureHtmlBody(parsedBodyHtml, parsedBodyText)
          : '';
      const bodyText =
        parsedBodyText ||
        this.htmlToText(bodyHtml || parsedBodyHtml) ||
        `Hi {{firstName}}, ...`;

      return {
        subject: parsed.subject || `Outreach to ${dto.audience}`,
        bodyHtml,
        bodyText,
      };
    } catch (error: any) {
      console.error('Gemini API Error:', {
        message: error.message,
        status: error.status,
        details: error.response?.data || error.error || error,
      });
      throw new BadRequestException('AI Generation failed: ' + error.message);
    }
  }

  private async runTemplateGenerationJob(
    id: string,
    dto: GenerateTemplateDto,
    userId: string,
  ) {
    const started = new Date().toISOString();
    const current = this.generationJobs.get(id);
    if (!current) return;

    this.generationJobs.set(id, {
      ...current,
      status: 'PROCESSING',
      updatedAt: started,
    });

    try {
      const result = await this.generateAiTemplate(dto, userId);
      this.generationJobs.set(id, {
        ...this.generationJobs.get(id)!,
        status: 'COMPLETED',
        result,
        updatedAt: new Date().toISOString(),
      });
    } catch (error: any) {
      this.generationJobs.set(id, {
        ...this.generationJobs.get(id)!,
        status: 'FAILED',
        error: error.message || 'Template generation failed',
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private normalizeTemplate<T extends Partial<CreateTemplateDto>>(
    dto: T,
    requireBody = true,
  ) {
    const normalized = this.normalizeTemplateBodies(dto, requireBody);

    if (dto.attachments !== undefined) {
      return {
        ...normalized,
        attachments: this.normalizeAttachments(dto.attachments),
      };
    }

    return normalized;
  }

  private buildReferenceContext(
    referenceText?: string,
    referenceName?: string,
  ) {
    const cleaned = this.cleanReferenceText(referenceText || '');

    if (!cleaned) return '';

    const capped = cleaned.slice(0, 8000);
    return referenceName ? `Source: ${referenceName}\n${capped}` : capped;
  }

  private cleanReferenceText(value: string) {
    return value.replace(/\s+/g, ' ').replaceAll('\u0000', '').trim();
  }

  private normalizeTemplateBodies<T extends Partial<CreateTemplateDto>>(
    dto: T,
    requireBody = true,
  ): T & { bodyHtml: string; bodyText: string } {
    const hasBodyHtml = dto.bodyHtml !== undefined;
    const hasBodyText = dto.bodyText !== undefined;

    if (!requireBody && !hasBodyHtml && !hasBodyText) {
      return dto as T & { bodyHtml: string; bodyText: string };
    }

    const bodyHtml = dto.bodyHtml ?? '';
    const bodyText = dto.bodyText ?? '';

    if (requireBody && !bodyHtml.trim() && !bodyText.trim()) {
      throw new BadRequestException(
        'Template requires either HTML body or text body',
      );
    }

    return {
      ...dto,
      bodyHtml,
      bodyText: bodyText || this.htmlToText(bodyHtml),
    };
  }

  private normalizeAttachments(
    attachments: CreateTemplateDto['attachments'] = [],
  ) {
    if (attachments.length > MAX_TEMPLATE_ATTACHMENTS) {
      throw new BadRequestException(
        `Templates can include up to ${MAX_TEMPLATE_ATTACHMENTS} attachments`,
      );
    }

    let totalBytes = 0;

    const normalized = attachments.map((attachment, index) => {
      const name = attachment.name?.trim();
      const contentBase64 = attachment.contentBase64?.trim();
      const contentType =
        attachment.contentType?.trim() || 'application/octet-stream';

      if (!name) {
        throw new BadRequestException(
          `Attachment ${index + 1} needs a file name`,
        );
      }

      if (!contentBase64) {
        throw new BadRequestException(
          `Attachment ${name} is missing file content`,
        );
      }

      // Derive the size from the payload rather than trusting the client-sent
      // `size` field — otherwise a caller can declare 1 byte and post an
      // arbitrarily large blob straight past the per-file cap.
      const size = this.decodedBase64Bytes(contentBase64);

      if (size <= 0) {
        throw new BadRequestException(
          `Attachment ${name} is empty or not valid base64`,
        );
      }

      if (size > MAX_TEMPLATE_ATTACHMENT_BYTES) {
        throw new BadRequestException(
          `Attachment ${name} must be 5 MB or smaller`,
        );
      }

      totalBytes += size;

      return {
        id: attachment.id || `attachment-${Date.now()}-${index}`,
        name,
        contentType,
        size,
        contentBase64,
      };
    });

    if (totalBytes > MAX_TEMPLATE_ATTACHMENTS_TOTAL_BYTES) {
      throw new BadRequestException(
        `Attachments total ${this.formatBytes(totalBytes)}, which is over the ` +
          `${this.formatBytes(MAX_TEMPLATE_ATTACHMENTS_TOTAL_BYTES)} limit for a single email. ` +
          'Remove a file or attach a download link instead.',
      );
    }

    return normalized;
  }

  /** Decoded byte length of a base64 string, without allocating a Buffer. */
  private decodedBase64Bytes(value: string) {
    const clean = value.replace(/\s/g, '');
    if (!clean || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return 0;
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.floor((clean.length * 3) / 4) - padding;
  }

  private formatBytes(bytes: number) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  private htmlToText(html: string) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private ensureHtmlBody(html: string, fallbackText: string) {
    if (/<[a-z][\s\S]*>/i.test(html)) {
      return html;
    }

    const sourceText = html || fallbackText;
    const paragraphs = sourceText
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

    return paragraphs.length > 0
      ? paragraphs
          .map(
            (paragraph) =>
              `<p>${this.escapeHtml(paragraph).replace(/\n/g, '<br/>')}</p>`,
          )
          .join('')
      : '<p>Hi {{firstName}},</p>';
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
