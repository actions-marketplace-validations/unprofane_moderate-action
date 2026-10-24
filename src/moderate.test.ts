import { describe, expect, it } from 'vitest';
import {
  exemption,
  MAX_TEXT_CHARS,
  plan,
  prepare,
  readInputs,
  type Target,
  targetOf,
  verdictOf,
} from './moderate.ts';

const inputs = readInputs({
  'INPUT_API-KEY': 'up_test_x',
  'INPUT_EXEMPT-ASSOCIATIONS': 'OWNER,MEMBER,COLLABORATOR',
  'INPUT_EXEMPT-BOTS': 'true',
});
const user = { login: 'pat', type: 'User' };

describe('readInputs', () => {
  it('defaults to hiding and labelling a block, labelling a review', () => {
    expect(inputs.onBlock).toEqual(['hide', 'label']);
    expect(inputs.onReview).toEqual(['label']);
    expect(inputs.policy).toBe('standard');
    expect(inputs.checkCode).toBe(false);
  });

  it('refuses an empty key and an unknown step', () => {
    expect(() => readInputs({})).toThrow(/api-key/);
    expect(() =>
      readInputs({ 'INPUT_API-KEY': 'up_test_x', 'INPUT_ON-BLOCK': 'hide,ban' }),
    ).toThrow(/unknown step ban/);
  });
});

describe('targetOf', () => {
  it('reads an issue comment with its node id and issue number', () => {
    const t = targetOf('issue_comment', {
      action: 'created',
      issue: { number: 7 },
      comment: { node_id: 'IC_1', body: 'hi', user, author_association: 'NONE', html_url: 'u' },
    });
    expect(t).toMatchObject({ kind: 'issue comment', texts: ['hi'], commentId: 'IC_1', number: 7 });
  });

  it('reads a pull request title and body, and a discussion comment', () => {
    expect(
      targetOf('pull_request_target', {
        action: 'opened',
        pull_request: { number: 3, title: 'T', body: null, user },
      })?.texts,
    ).toEqual(['T']);
    expect(
      targetOf('discussion_comment', {
        action: 'edited',
        discussion: { node_id: 'D_1' },
        comment: { node_id: 'DC_1', body: 'b', user },
      }),
    ).toMatchObject({ commentId: 'DC_1', discussionId: 'D_1' });
  });

  it('has nothing to check on a deletion, a close or another event', () => {
    expect(targetOf('issue_comment', { action: 'deleted', comment: { body: 'x' } })).toBeNull();
    expect(targetOf('issues', { action: 'closed', issue: { title: 'x' } })).toBeNull();
    expect(targetOf('push', {})).toBeNull();
    expect(
      targetOf('pull_request_review', { action: 'submitted', review: { body: null } }),
    ).toBeNull();
  });

  it('knows a bot by its type or its [bot] login', () => {
    const t = targetOf('issue_comment', {
      action: 'created',
      comment: { body: 'x', user: { login: 'dependabot[bot]', type: 'User' } },
    });
    expect(t?.isBot).toBe(true);
  });
});

describe('exemption', () => {
  const t = (association: string, isBot = false): Target => ({
    kind: 'issue comment',
    texts: ['x'],
    author: 'pat',
    association,
    isBot,
    url: 'u',
  });
  it('skips maintainers and bots, checks everyone else', () => {
    expect(exemption(t('MEMBER'), inputs)).toMatch(/member/);
    expect(exemption(t('NONE', true), inputs)).toMatch(/bot/);
    expect(exemption(t('CONTRIBUTOR'), inputs)).toBeNull();
    expect(exemption(t('OWNER'), { ...inputs, exemptAssociations: [] })).toBeNull();
  });
});

describe('prepare', () => {
  it('leaves out template comments, quoted replies and code', () => {
    const body = [
      '<!-- Describe the bug -->',
      '> you idiot',
      'Thanks, this works.',
      '```',
      'const shit = 1;',
      '```',
      'Run `kill -9` first.',
    ].join('\n');
    expect(prepare([body], false)).toEqual(['Thanks, this works.\n\nRun  first.']);
    expect(prepare([body], true)[0]).toContain('const shit = 1;');
  });

  it('drops texts with no prose and splits long ones at line ends', () => {
    expect(prepare(['<!-- only a template -->', '   '], false)).toEqual([]);
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${'word '.repeat(10)}end`).join(
      '\n',
    );
    const pieces = prepare([long], false);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(pieces.join('\n')).toBe(long);
  });
});

describe('verdictOf and plan', () => {
  const answers = [
    { id: 'chk_a', action: 'allow' as const, decided_by: [] },
    { id: 'chk_b', action: 'review' as const, decided_by: [{ category: 'insult' }] },
    { id: 'chk_c', action: 'block' as const, decided_by: [{ category: 'slur' }] },
  ];
  it('takes the strictest answer and the categories behind it', () => {
    expect(verdictOf(answers)).toEqual({
      action: 'block',
      categories: ['slur'],
      ids: ['chk_a', 'chk_b', 'chk_c'],
    });
    expect(verdictOf([]).action).toBe('allow');
  });

  it('hides comments only, and says why a step was skipped', () => {
    const issue: Target = {
      kind: 'issue',
      texts: [],
      number: 4,
      author: 'pat',
      association: 'NONE',
      isBot: false,
      url: 'u',
    };
    expect(plan('block', issue, inputs)).toEqual({
      steps: ['label'],
      skipped: ['hide: only a comment can be hidden, not the issue'],
    });
    expect(plan('block', { ...issue, commentId: 'IC_1' }, inputs).steps).toEqual(['hide', 'label']);
    expect(plan('allow', issue, inputs).steps).toEqual([]);
    expect(plan('review', issue, { ...inputs, onReview: ['reply'], reply: '' }).skipped).toEqual([
      'reply: the reply input is empty',
    ]);
  });
});
