export const MAIL_FOLDERS = [
  'inbox',
  'starred',
  'sent',
  'drafts',
  'scheduled',
  'campaigns',
  'archive',
  'trash',
] as const;

export type MailFolder = (typeof MAIL_FOLDERS)[number];

/** Which threads each folder shows, from the flags refreshThread keeps. */
export function folderFilter(folder: MailFolder): Record<string, unknown> {
  switch (folder) {
    case 'starred':
      return { starred: true, trashed: false };
    case 'sent':
      return { hasSent: true, trashed: false };
    case 'drafts':
      return { draftCount: { $gt: 0 }, trashed: false };
    case 'scheduled':
      return { scheduledCount: { $gt: 0 }, trashed: false };
    // Every campaign conversation that has mail in it, replied to or not.
    case 'campaigns':
      return {
        campaignId: { $ne: null },
        lastMessageAt: { $ne: null },
        trashed: false,
      };
    case 'archive':
      return { archived: true, trashed: false };
    case 'trash':
      return { trashed: true };
    default:
      return { hasInbound: true, archived: false, trashed: false };
  }
}

/** Drafts and scheduled sends sort by their latest edit, the rest by mail. */
export function folderSortField(folder: MailFolder) {
  return folder === 'drafts' || folder === 'scheduled'
    ? 'lastActivityAt'
    : 'lastMessageAt';
}
