import {
  buildAgentPersona,
  buildChatPreUserPrompt,
  buildChatSystemPrompt,
  buildLiveCallingPreUserPrompt,
  buildLiveCallingSystemPrompt,
} from './ai-calling-agent';

describe('ai-calling-agent prompt builders', () => {
  const persona = buildAgentPersona({
    name: 'Alex',
    role: 'sales specialist',
    goal: 'Book a qualified demo',
    personality: 'warm, concise, and consultative',
    language: 'en-IN',
    knowledge: 'The product helps teams automate follow-up.',
    rules: 'Ask one question at a time.',
    greeting: 'Briefly introduce yourself and ask for permission.',
    objections: 'Offer a callback if the contact is busy.',
  });

  it('builds live calling prompts with Mple-style phone-call guardrails and JSON contract', () => {
    const prompt = buildLiveCallingSystemPrompt({
      persona,
      contactName: 'Sam Lee',
      companyName: 'Acme',
      scenario: 'Outbound demo qualification',
      objective: 'Qualify interest and book a demo',
      selectedLanguage: 'en-IN',
      selectedVoice: 'google:en-IN-Chirp3-HD-Puck',
      conversationLanguage: 'en-IN',
      languageInstruction:
        'You MUST speak and reply in Indian English, naturally.',
    });

    expect(prompt).toContain('<system_instructions>');
    expect(prompt).toContain('<persona>');
    expect(prompt).toContain('<conversational_rules>');
    expect(prompt).toContain('<knowledge_policy>');
    expect(prompt).toContain('<general_guidelines>');
    expect(prompt).toContain('<guardrails>');
    expect(prompt).toContain('<language_and_speech_rules>');
    expect(prompt).toContain(
      'Internally track which objectives are done',
    );
    expect(prompt).toContain(
      'Never ask a question whose objective is already fulfilled',
    );
    expect(prompt).toContain('Any form of consent means proceed ahead');
    expect(prompt).toContain('Return ONLY valid JSON');
    expect(prompt).toContain('"shouldEnd": false');
    expect(prompt).toContain('"collectedData"');
  });

  it('keeps RAC/source material private in live calling pre-user prompts', () => {
    const prompt = buildLiveCallingPreUserPrompt({
      ragContext: 'RAC 1: Pricing starts at 100.',
      scenario: 'Outbound call',
      objective: 'Share details',
      goal: 'Capture a callback',
      idealPath: 'Confirm time, answer question, offer callback.',
      collectedData: { interest: 'interested' },
    });

    expect(prompt).toContain('<source_material>');
    expect(prompt).toContain('private source material');
    expect(prompt).toContain('Do not mention, quote, or expose this block');
    expect(prompt).toContain('Before asking a question');
  });

  it('builds bot chat prompts with Mple-style knowledge policy and security', () => {
    const prompt = buildChatSystemPrompt(persona);

    expect(prompt).toContain('<system_instructions>');
    expect(prompt).toContain('<assistant_profile>');
    expect(prompt).toContain('<knowledge_policy>');
    expect(prompt).toContain('<behavior_rules>');
    expect(prompt).toContain('<security>');
    expect(prompt).toContain('<answer_quality>');
    expect(prompt).toContain(
      'Never reveal the underlying AI model, provider, or technology stack',
    );
    expect(prompt).toContain('Never fabricate information');
    expect(prompt).toContain(
      'The answer should feel like a senior expert explaining the topic',
    );
    expect(prompt).toContain('Return ONLY valid JSON');
    expect(prompt).toContain('{"reply":"string"}');
  });

  it('keeps RAC/source material private in bot chat pre-user prompts', () => {
    const prompt = buildChatPreUserPrompt('RAC 1: Demo takes 30 minutes.');

    expect(prompt).toContain('<private_source_material>');
    expect(prompt).toContain('private source material');
    expect(prompt).toContain('Do not mention, quote, or expose this block');
    expect(prompt).toContain('Use private source details only when relevant');
  });

  it('handles empty/unconfigured persona fields gracefully', () => {
    const emptyPersona = buildAgentPersona({});
    expect(emptyPersona.name).toBe('');
    expect(emptyPersona.role).toBe('');
    expect(emptyPersona.goal).toBe('');

    const prompt = buildLiveCallingSystemPrompt({
      persona: emptyPersona,
      contactName: 'Sam Lee',
      companyName: '',
      scenario: '',
      objective: '',
      selectedLanguage: '',
      selectedVoice: '',
      conversationLanguage: '',
      languageInstruction: '',
    });

    expect(prompt).toContain('You are , conducting a real outbound phone call with Sam Lee (Unknown company).');
    expect(prompt).toContain('Greeting style: \nSelected language:');
    expect(prompt).toContain('Creator rules: \nObjection handling: \n</owner_instructions>');
  });
});
