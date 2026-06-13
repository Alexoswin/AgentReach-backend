import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { GenerateTemplateDto } from './dto/generate-template.dto';
import { resolveOpenRouterModel } from '../config/openrouter';

@Injectable()
export class TemplatesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.template.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const template = await this.prisma.template.findUnique({
      where: { id },
    });
    if (!template) {
      throw new BadRequestException('Template not found');
    }
    return template;
  }

  async create(dto: CreateTemplateDto) {
    const data = this.normalizeTemplateBodies(dto);

    return this.prisma.template.create({
      data,
    });
  }

  async update(id: string, dto: Partial<CreateTemplateDto>) {
    await this.findOne(id);
    const data = this.normalizeTemplateBodies(dto, false);

    return this.prisma.template.update({
      where: { id },
      data,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.template.delete({
      where: { id },
    });
  }

  getPredefinedTemplates() {
    return [
      {
        id: 'predefined-job-app',
        name: 'Standard Job Application',
        category: 'Job Application',
        subject: 'Application for {{jobTitle}} - {{firstName}} {{lastName}}',
        bodyText: 'Dear hiring team at {{company}},\n\nI am writing to express my interest in the {{jobTitle}} position at your company. With my background in software engineering, I am confident I can make an immediate contribution to your team.\n\nBest regards,\n{{lastName}}',
        bodyHtml: '<p>Dear hiring team at {{company}},</p><p>I am writing to express my interest in the <strong>{{jobTitle}}</strong> position at your company. With my background in software engineering, I am confident I can make an immediate contribution to your team.</p><p>Best regards,<br/>{{lastName}}</p>',
        type: 'PREDEFINED',
      },
      {
        id: 'predefined-recruiter',
        name: 'Recruiter Outreach',
        category: 'Recruiter Outreach',
        subject: 'Experienced {{jobTitle}} open to new roles',
        bodyText: 'Hi {{firstName}},\n\nI saw that you recruit for {{jobTitle}} roles at {{company}}. I am currently exploring new opportunities and would love to see if my background matches any active roles you are sourcing for.\n\nBest,\n{{lastName}}',
        bodyHtml: '<p>Hi {{firstName}},</p><p>I saw that you recruit for <strong>{{jobTitle}}</strong> roles at {{company}}. I am currently exploring new opportunities and would love to see if my background matches any active roles you are sourcing for.</p><p>Best,<br/>{{lastName}}</p>',
        type: 'PREDEFINED',
      },
      {
        id: 'predefined-hiring-manager',
        name: 'Hiring Manager Quick Pitch',
        category: 'Hiring Manager Outreach',
        subject: 'Quick question regarding {{jobTitle}} at {{company}}',
        bodyText: 'Hi {{firstName}},\n\nI saw you lead the engineering team at {{company}}. I noticed you are hiring a {{jobTitle}} and wanted to reach out directly to highlight my experience with systems design and React.\n\nWould you be open to a quick 5-minute chat next week?\n\nThanks,\n{{lastName}}',
        bodyHtml: '<p>Hi {{firstName}},</p><p>I saw you lead the engineering team at {{company}}. I noticed you are hiring a <strong>{{jobTitle}}</strong> and wanted to reach out directly to highlight my experience with systems design and React.</p><p>Would you be open to a quick 5-minute chat next week?</p><p>Thanks,<br/>{{lastName}}</p>',
        type: 'PREDEFINED',
      },
      {
        id: 'predefined-networking',
        name: 'Informational Interview Request',
        category: 'Networking',
        subject: 'Learning from your career path at {{company}}',
        bodyText: 'Hi {{firstName}},\n\nI came across your profile and was very impressed by your journey as a {{jobTitle}} at {{company}}. I am looking to grow my career in the same space and would love to buy you a virtual coffee to ask a few questions about your career path.\n\nSincerely,\n{{lastName}}',
        bodyHtml: '<p>Hi {{firstName}},</p><p>I came across your profile and was very impressed by your journey as a <strong>{{jobTitle}}</strong> at {{company}}. I am looking to grow my career in the same space and would love to buy you a virtual coffee to ask a few questions about your career path.</p><p>Sincerely,<br/>{{lastName}}</p>',
        type: 'PREDEFINED',
      },
      {
        id: 'predefined-follow-up',
        name: 'Follow Up After Application',
        category: 'Follow Up',
        subject: 'Following up on application: {{jobTitle}} role',
        bodyText: 'Hi {{firstName}},\n\nI hope you are having a great week. I wanted to follow up on the {{jobTitle}} role at {{company}} that I applied for last week. I remain highly interested and wanted to see if you have any updates on the timeline.\n\nWarmly,\n{{lastName}}',
        bodyHtml: '<p>Hi {{firstName}},</p><p>I hope you are having a great week. I wanted to follow up on the <strong>{{jobTitle}}</strong> role at {{company}} that I applied for last week. I remain highly interested and wanted to see if you have any updates on the timeline.</p><p>Warmly,<br/>{{lastName}}</p>',
        type: 'PREDEFINED',
      },
      {
        id: 'predefined-partnership',
        name: 'Partnership Outreach',
        category: 'Partnership Outreach',
        subject: 'Exploring synergies between our teams',
        bodyText: 'Hi {{firstName}},\n\nI hope this email finds you well. As the {{jobTitle}} at {{company}}, I wanted to reach out regarding a potential collaboration. We help companies scale their operations and I believe there is a strong synergy between our offerings.\n\nLet me know if you are open to discussing this.\n\nBest,\n{{lastName}}',
        bodyHtml: '<p>Hi {{firstName}},</p><p>I hope this email finds you well. As the <strong>{{jobTitle}}</strong> at {{company}}, I wanted to reach out regarding a potential collaboration. We help companies scale their operations and I believe there is a strong synergy between our offerings.</p><p>Let me know if you are open to discussing this.</p><p>Best,<br/>{{lastName}}</p>',
        type: 'PREDEFINED',
      },
    ];
  }

  async generateAiTemplate(dto: GenerateTemplateDto) {
    const format = dto.format || 'HTML';
    const settings = await this.prisma.systemSettings.findUnique({
      where: { id: 'default' },
    });

    const hasNoKey = !settings || !settings.openRouterApiKey;
    const isMockKey = settings && (
      settings.openRouterApiKey.toLowerCase().includes('mock') ||
      settings.openRouterApiKey.toLowerCase().includes('test') ||
      settings.openRouterApiKey === ''
    );

    if (hasNoKey || isMockKey) {
      // Return highly relevant mock data on the fly
      const subject = `Opportunities in ${dto.audience} - Application/Intro`;
      const bodyText = `Hi {{firstName}},\n\nI am reaching out because my goal is to ${dto.goal}. I noticed you represent ${dto.audience} and wanted to introduce myself in a ${dto.tone} manner.\n\n${dto.instructions || ''}\n\nLooking forward to speaking,\n{{lastName}}`;
      const bodyHtml = format === 'HTML'
        ? `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2937;"><p>Hi {{firstName}},</p><p>I am reaching out because my goal is to <strong>${dto.goal}</strong>. I noticed you represent <strong>${dto.audience}</strong> and wanted to introduce myself in a <em>${dto.tone}</em> manner.</p><p>${dto.instructions || ''}</p><p>Looking forward to speaking,<br/>{{lastName}}</p></div>`
        : '';

      return {
        subject,
        bodyHtml,
        bodyText,
        generatedByMock: true,
      };
    }

    try {
      const bodyInstructions = format === 'HTML'
        ? `2. "bodyHtml" - A real HTML email body, not plain text. Use valid HTML tags such as <div>, <p>, <strong>, <a>, and <br>. Use simple inline styles that work in email clients. Do not wrap it in markdown or code fences.
3. "bodyText" - The plain text fallback equivalent of the HTML body.`
        : `2. "bodyHtml" - Return an empty string.
3. "bodyText" - The plain text email body. Do not include HTML tags.`;

      const prompt = `You are an expert copywriter. Write a highly personalized ${format} outreach email campaign template based on:
Goal: ${dto.goal}
Target Audience: ${dto.audience}
Tone: ${dto.tone}
Special Instructions: ${dto.instructions || 'None'}

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

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${settings.openRouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://reachconvert.com',
          'X-Title': 'ReachConvert',
        },
        body: JSON.stringify({
          model: resolveOpenRouterModel(settings.openRouterModel),
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
        }),
      });

      const data = (await response.json()) as any;
      if (!response.ok) {
        throw new Error(data.error?.message || response.statusText);
      }

      const contentString = data.choices?.[0]?.message?.content;
      if (!contentString) {
        throw new Error('Empty response received from OpenRouter');
      }

      // Handle raw markdown wrappers in response if any
      let cleanedJson = contentString.trim();
      if (cleanedJson.startsWith('```')) {
        cleanedJson = cleanedJson.replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
      }

      const parsed = JSON.parse(cleanedJson);
      const bodyText = parsed.bodyText || this.htmlToText(parsed.bodyHtml || '') || `Hi {{firstName}}, ...`;

      return {
        subject: parsed.subject || `Outreach to ${dto.audience}`,
        bodyHtml: format === 'HTML' ? this.ensureHtmlBody(parsed.bodyHtml || '', bodyText) : '',
        bodyText,
      };
    } catch (error: any) {
      throw new BadRequestException('AI Generation failed: ' + error.message);
    }
  }

  private normalizeTemplateBodies<T extends Partial<CreateTemplateDto>>(dto: T, requireBody = true): T & { bodyHtml: string; bodyText: string } {
    const hasBodyHtml = dto.bodyHtml !== undefined;
    const hasBodyText = dto.bodyText !== undefined;

    if (!requireBody && !hasBodyHtml && !hasBodyText) {
      return dto as T & { bodyHtml: string; bodyText: string };
    }

    const bodyHtml = dto.bodyHtml ?? '';
    const bodyText = dto.bodyText ?? '';

    if (requireBody && !bodyHtml.trim() && !bodyText.trim()) {
      throw new BadRequestException('Template requires either HTML body or text body');
    }

    return {
      ...dto,
      bodyHtml,
      bodyText: bodyText || this.htmlToText(bodyHtml),
    };
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
      .map(paragraph => paragraph.trim())
      .filter(Boolean);

    return paragraphs.length > 0
      ? paragraphs.map(paragraph => `<p>${this.escapeHtml(paragraph).replace(/\n/g, '<br/>')}</p>`).join('')
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
