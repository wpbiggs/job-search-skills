/**
 * Reviewed submission intent. This is a policy-only foundation; it does not grant
 * an agent browser credentials or enable employer-facing actions.
 */
export type SubmissionIntent = Readonly<{
  userId: string;
  jobId: string;
  jobRevision: number;
  draftId: string;
  draftRevision: number;
  destination: string;
  payloadDigest: string;
  approvedAt: string;
  expiresAt: string;
  nonce: string;
}>;

export type SubmissionStatus = 'approved' | 'claimed' | 'requires_user' | 'submitted' | 'failed' | 'expired';
export type SubmissionRecord = { intent: SubmissionIntent; status: SubmissionStatus; receipt?: string };

export function validateIntent(intent: SubmissionIntent, now = new Date()): void {
  for (const id of [intent.userId, intent.jobId, intent.draftId]) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid identity binding');
  }
  if (!Number.isInteger(intent.jobRevision) || intent.jobRevision <= 0 ||
      !Number.isInteger(intent.draftRevision) || intent.draftRevision <= 0)
    throw new Error('Invalid revision');
  if (!/^[a-f0-9]{64}$/i.test(intent.payloadDigest)) throw new Error('Invalid payload digest');
  if (!/^[a-f0-9]{32,128}$/i.test(intent.nonce)) throw new Error('Invalid nonce');
  const url = new URL(intent.destination);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') ||
      url.port || /^(localhost|\d+(?:\.\d+){3})$/i.test(url.hostname) ||
      /\.(local|internal|test|invalid)$/i.test(url.hostname)) throw new Error('Invalid employer destination');
  const approval = Date.parse(intent.approvedAt), expiry = Date.parse(intent.expiresAt);
  if (!Number.isFinite(approval) || !Number.isFinite(expiry) || approval > now.getTime() ||
      expiry <= now.getTime() || expiry - approval > 30 * 60_000) throw new Error('Approval is expired or outside the allowed window');
}

export function assertExactApprovedSnapshot(
  intent: SubmissionIntent,
  actual: Pick<SubmissionIntent, 'userId'|'jobId'|'jobRevision'|'draftId'|'draftRevision'|'destination'|'payloadDigest'>,
  now = new Date(),
): void {
  validateIntent(intent, now);
  for (const field of ['userId','jobId','jobRevision','draftId','draftRevision','destination','payloadDigest'] as const)
    if (actual[field] !== intent[field]) throw new Error('Approval does not cover changed application content');
}

export function submissionTransition(
  record: SubmissionRecord,
  action: 'claim'|'handoff'|'confirm_receipt'|'fail',
  receipt?: string,
): SubmissionRecord {
  const allowed: Record<typeof action, [SubmissionStatus, SubmissionStatus]> = {
    claim: ['approved','claimed'],
    handoff: ['claimed','requires_user'],
    confirm_receipt: ['claimed','submitted'],
    fail: ['claimed','failed'],
  };
  const [from,to] = allowed[action];
  if (record.status !== from) throw new Error('Unapproved, stale, or repeated submission attempt');
  if (action === 'confirm_receipt' && (!receipt || receipt.trim().length < 8 || receipt.length > 500))
    throw new Error('Verified employer receipt evidence required');
  return { ...record, status: to, ...(action === 'confirm_receipt' ? { receipt: receipt!.trim() } : {}) };
}
