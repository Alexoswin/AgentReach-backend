import {
  buildFallbackChatReply,
  finalizeChatReply,
  looksLikeInstructionEcho,
  sanitizeFallbackReply,
} from './ai-calling-bots.chat-utils';

describe('ai-calling-bots chat utils prompt echo safety', () => {
  const leakedPrompt =
    'You are Alex, an outbound sales qualification specialist calling on behalf of Tata Motors regarding the new Tata Sierra. OBJECTIVE: * Introduce the Tata Sierra.';

  it('detects prompt-like instruction echoes with objective blocks', () => {
    expect(looksLikeInstructionEcho(leakedPrompt)).toBe(true);
  });

  it('sanitizes unsafe fallback content before sending chat replies', () => {
    const safe = sanitizeFallbackReply(leakedPrompt);

    expect(safe).not.toMatch(/you are alex/i);
    expect(safe).not.toMatch(/objective:/i);
    expect(safe).toContain('Tell me the exact model or variant');
  });

  it('does not reuse prompt-like bot knowledge in fallback answers', () => {
    const reply = buildFallbackChatReply(
      'what the price cost',
      {
        name: 'Alex',
        role: 'outbound sales qualification specialist',
        personality: 'warm and concise',
        knowledge: leakedPrompt,
      },
      [],
      '',
    );

    expect(reply).not.toMatch(/you are alex/i);
    expect(reply).not.toMatch(/objective:/i);
    expect(reply).toContain("I want to give you an accurate answer");
  });

  it('returns a safe fallback when llm reply is empty', () => {
    const reply = finalizeChatReply('', leakedPrompt, '');

    expect(reply).not.toMatch(/you are alex/i);
    expect(reply).toContain('Tell me the exact model or variant');
  });
});
