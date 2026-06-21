import {
  buildFallbackChatReply,
  finalizeChatReply,
  looksLikeInstructionEcho,
  sanitizeFallbackReply,
} from './ai-calling-bots.chat-utils';

describe('ai-calling-bots chat utils prompt echo safety', () => {
  const leakedPrompt =
    'You are AgentOne, an outbound assistant calling on behalf of Client Team. OBJECTIVE: Gather requirements and capture next step.';

  it('detects prompt-like instruction echoes with objective blocks', () => {
    expect(looksLikeInstructionEcho(leakedPrompt)).toBe(true);
  });

  it('detects persona prompt lines even without explicit objective headings', () => {
    expect(
      looksLikeInstructionEcho(
        'You are AgentOne, an outbound assistant calling on behalf of Client Team regarding a new initiative.',
      ),
    ).toBe(true);
  });

  it('sanitizes unsafe fallback content before sending chat replies', () => {
    const safe = sanitizeFallbackReply(leakedPrompt);

    expect(safe).not.toMatch(/you are agentone/i);
    expect(safe).not.toMatch(/objective:/i);
    expect(safe).toContain('Share the exact detail you need');
  });

  it('does not reuse prompt-like bot knowledge in fallback answers', () => {
    const reply = buildFallbackChatReply(
      'what the price cost',
      {
        name: 'AgentOne',
        role: 'outbound assistant',
        personality: 'warm and concise',
        knowledge: leakedPrompt,
      },
      [],
      '',
    );

    expect(reply).not.toMatch(/you are agentone/i);
    expect(reply).not.toMatch(/objective:/i);
    expect(reply).toContain('I want to give you an accurate answer');
  });

  it('returns a safe fallback when llm reply is empty', () => {
    const reply = finalizeChatReply('', leakedPrompt, '');

    expect(reply).not.toMatch(/you are agentone/i);
    expect(reply).toContain('Share the exact detail you need');
  });

  it('answers factual cost questions with a dynamic role-aligned follow-up', () => {
    const reply = buildFallbackChatReply(
      'what is the cost',
      {
        name: 'Agent',
        role: 'interviewer',
        personality: 'warm and concise',
        knowledge:
          'Base package starts around 100 and premium options can go up to 300 depending on selected add-ons.',
        rules: 'After answering directly, suggest one practical next step.',
      },
      [
        {
          content:
            'Final on-road cost depends on local taxes and registration.',
        } as any,
      ],
      '',
    );

    expect(reply).toMatch(/cost|100|300|taxes|registration/i);
    expect(reply).toMatch(/next step|configured|interviewer|settings|rules/i);
    expect(reply).not.toMatch(/tata|sierra|agentone/i);
  });
});
