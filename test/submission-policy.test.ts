import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIntent, assertExactApprovedSnapshot, submissionTransition, type SubmissionIntent } from '../src/submission-policy.ts';

const NOW = new Date('2026-11-06T15:00:00.000Z');
const makeIntent = (): SubmissionIntent => ({
  userId: '00000000-0000-4000-8000-000000000001',
  jobId: '00000000-0000-4000-8000-000000000002',
  jobRevision: 1,
  draftId: '00000000-0000-4000-8000-000000000003',
  draftRevision: 2,
  destination: 'https://jobs.example.org/apply/123',
  payloadDigest: 'a'.repeat(64),
  nonce: 'b'.repeat(64),
  approvedAt: '2026-11-06T14:55:00.000Z',
  expiresAt: '2026-11-06T15:10:00.000Z',
});

test('validates exact authorized application and time window', () => {
  const intent = makeIntent();
  assert.doesNotThrow(() => validateIntent(intent, NOW));
  assert.doesNotThrow(() => assertExactApprovedSnapshot(intent, intent, NOW));
  assert.throws(() => assertExactApprovedSnapshot(intent, { ...intent, draftRevision: 3 }, NOW));
  assert.throws(() => assertExactApprovedSnapshot(intent, { ...intent, payloadDigest: 'c'.repeat(64) }, NOW));
  assert.throws(() => assertExactApprovedSnapshot(intent, { ...intent, destination: 'https://other.example.org/apply' }, NOW));
});

test('rejects old, future, or oversized approval grants', () => {
  const intent = makeIntent();
  assert.throws(() => validateIntent(intent, new Date('2026-11-06T15:20:00Z')));
  assert.throws(() => validateIntent({ ...intent, approvedAt: '2026-11-06T15:05:00Z' }, NOW));
  assert.throws(() => validateIntent({ ...intent, expiresAt: '2026-11-06T17:00:00Z' }, NOW));
});

test('rejects private or non-TLS employer destinations', () => {
  const intent = makeIntent();
  for (const destination of ['http://jobs.example.org/apply', 'https://localhost/apply', 'https://127.0.0.1/apply', 'https://acme.internal/apply', 'https://user:password@jobs.example.org/apply']) {
    assert.throws(() => validateIntent({ ...intent, destination }, NOW), destination);
  }
});

test('allows one claim and records only receipt-supported submission', () => {
  const intent = makeIntent();
  const claimed = submissionTransition({ intent, status: 'approved' }, 'claim');
  assert.equal(claimed.status, 'claimed');
  assert.throws(() => submissionTransition(claimed, 'claim'));
  assert.throws(() => submissionTransition(claimed, 'confirm_receipt'));
  const submitted = submissionTransition(claimed, 'confirm_receipt', 'ATS confirmation: ABC123');
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.receipt, 'ATS confirmation: ABC123');
  assert.throws(() => submissionTransition(submitted, 'confirm_receipt', 'Another confirmation'));
});
