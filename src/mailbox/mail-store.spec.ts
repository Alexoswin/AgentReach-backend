import { summarizeThread } from './mail-store.service';
import { folderFilter } from './mail-folders';

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 14, 10, minutes));

const outbound = (overrides: Record<string, unknown> = {}) => ({
  direction: 'OUTBOUND',
  source: 'MANUAL',
  status: 'SENT',
  from: { email: 'owner@acme.com' },
  to: [{ email: 'jane@client.com', name: 'Jane' }],
  cc: [],
  subject: 'Plan',
  snippet: 'Here is the plan',
  attachments: [],
  sentAt: at(1),
  createdAt: at(0),
  updatedAt: at(1),
  ...overrides,
});

const inbound = (overrides: Record<string, unknown> = {}) => ({
  direction: 'INBOUND',
  status: 'RECEIVED',
  from: { email: 'jane@client.com', name: 'Jane' },
  to: [{ email: 'reply+t@reply.acme.com' }],
  cc: [{ email: 'boss@client.com' }],
  subject: 'Re: Plan',
  snippet: 'Looks good',
  attachments: [{ fileId: 'f', name: 'a.pdf', inline: false }],
  readAt: null,
  receivedAt: at(5),
  createdAt: at(5),
  updatedAt: at(5),
  ...overrides,
});

describe('summarizeThread', () => {
  it('derives the inbox fields from a sent email and its unread reply', () => {
    const summary = summarizeThread([outbound(), inbound()]);
    expect(summary).toMatchObject({
      subject: 'Plan',
      snippet: 'Looks good',
      messageCount: 2,
      unreadCount: 1,
      hasInbound: true,
      hasSent: true,
      draftCount: 0,
      scheduledCount: 0,
      hasAttachments: true,
      lastDirection: 'INBOUND',
      lastStatus: 'RECEIVED',
    });
    expect(summary.lastMessageAt).toEqual(at(5));
    // The owner's own addresses and the reply address are not participants.
    expect(summary.participants.map((p) => p.email)).toEqual([
      'jane@client.com',
      'boss@client.com',
    ]);
  });

  it('leaves drafts and queued sends out of the conversation', () => {
    const summary = summarizeThread([
      outbound({ status: 'DRAFT', sentAt: null, updatedAt: at(9) }),
      outbound({ status: 'QUEUED', scheduled: true, sentAt: null }),
      outbound({ status: 'CANCELLED', sentAt: null }),
    ]);
    expect(summary).toMatchObject({
      messageCount: 0,
      hasSent: false,
      hasInbound: false,
      draftCount: 1,
      scheduledCount: 1,
      lastMessageAt: null,
    });
    expect(summary.lastActivityAt).toEqual(at(9));
  });

  it('puts campaign emails in Sent, but not ones that failed to send', () => {
    expect(summarizeThread([outbound({ source: 'CAMPAIGN' })]).hasSent).toBe(
      true,
    );
    expect(
      summarizeThread([outbound({ source: 'CAMPAIGN', status: 'FAILED' })])
        .hasSent,
    ).toBe(false);
  });

  it('counts a read reply as read', () => {
    expect(summarizeThread([inbound({ readAt: at(6) })]).unreadCount).toBe(0);
  });
});

describe('folderFilter', () => {
  it('keeps trashed conversations out of every folder but Trash', () => {
    for (const folder of [
      'inbox',
      'starred',
      'sent',
      'drafts',
      'scheduled',
      'campaigns',
      'archive',
    ] as const) {
      expect(folderFilter(folder)).toMatchObject({ trashed: false });
    }
    expect(folderFilter('trash')).toEqual({ trashed: true });
    expect(folderFilter('inbox')).toEqual({
      hasInbound: true,
      archived: false,
      trashed: false,
    });
  });

  it('shows every campaign conversation with mail in it, replied or not', () => {
    expect(folderFilter('campaigns')).toEqual({
      campaignId: { $ne: null },
      lastMessageAt: { $ne: null },
      trashed: false,
    });
    expect(folderFilter('sent')).toEqual({ hasSent: true, trashed: false });
  });
});
