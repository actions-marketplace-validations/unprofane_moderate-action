import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from './main.ts';

// biome-ignore lint/suspicious/noExplicitAny: a recorded request body, read field by field
type Call = { url: string; method: string; body: any };

/** A fetch that answers as Unprofane and GitHub would, and records each call. */
function fake(action: 'allow' | 'review' | 'block', { labelExists = true } = {}) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const impl = (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init.method ?? 'GET', body });
    if (url.endsWith('/v1/check/batch'))
      return json({
        results: body.items.map((i: { id: string }, n: number) => ({
          id: i.id,
          result: {
            id: `chk_${'a'.repeat(15)}${n}`,
            action,
            decided_by: action === 'allow' ? [] : [{ category: 'insult', action, from: 'words' }],
          },
        })),
      });
    if (url.endsWith('/graphql')) return json({ data: {} });
    if (url.includes('/labels/') && !labelExists) return json({ message: 'Not Found' }, 404);
    if (url.includes('/labels')) return json({ node_id: 'LA_1' });
    return json({});
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function env(eventName: string, payload: unknown, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'moderate-'));
  writeFileSync(join(dir, 'event.json'), JSON.stringify(payload));
  writeFileSync(join(dir, 'out'), '');
  return {
    dir,
    env: {
      'INPUT_API-KEY': 'up_test_abc',
      'INPUT_GITHUB-TOKEN': 'ghs_x',
      'INPUT_EXEMPT-ASSOCIATIONS': 'OWNER,MEMBER,COLLABORATOR',
      'INPUT_EXEMPT-BOTS': 'true',
      'INPUT_ON-BLOCK': 'hide,label',
      'INPUT_ON-REVIEW': 'label',
      INPUT_LABEL: 'needs-moderation',
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: join(dir, 'event.json'),
      GITHUB_OUTPUT: join(dir, 'out'),
      GITHUB_REPOSITORY: 'acme/widgets',
      GITHUB_API_URL: 'https://api.github.com',
      ...extra,
    },
  };
}

const comment = {
  action: 'created',
  issue: { number: 12 },
  comment: {
    node_id: 'IC_9',
    body: 'you are a f.u.c.k.i.n.g clown',
    user: { login: 'troll', type: 'User' },
    author_association: 'NONE',
    html_url: 'https://github.com/acme/widgets/issues/12#issuecomment-9',
  },
};

describe('run', () => {
  it('hides a blocked comment and labels its issue, logging no text', async () => {
    const { calls, impl } = fake('block');
    const { env: e, dir } = env('issue_comment', comment);
    const lines: string[] = [];
    expect(await run(e, impl, (l) => lines.push(l))).toBe(0);
    const check = calls.find((c) => c.url === 'https://api.unprofane.com/v1/check/batch');
    expect(check?.body).toMatchObject({ context: 'comment', policy: 'standard' });
    expect(check?.body.items[0].text).toBe(comment.comment.body);
    const hide = calls.find((c) => c.url.endsWith('/graphql'));
    expect(hide?.body.query).toContain('minimizeComment');
    expect(hide?.body.variables).toEqual({ id: 'IC_9' });
    expect(
      calls.find((c) => c.url === 'https://api.github.com/repos/acme/widgets/issues/12/labels')
        ?.body,
    ).toEqual({ labels: ['needs-moderation'] });
    expect(readFileSync(join(dir, 'out'), 'utf8')).toContain('action=block\ncategories=insult\n');
    expect(lines.join('\n')).not.toContain('clown');
  });

  it('creates the label when the repository has none', async () => {
    const { calls, impl } = fake('review', { labelExists: false });
    const { env: e } = env('issue_comment', comment);
    expect(await run(e, impl, () => {})).toBe(0);
    expect(
      calls.find((c) => c.method === 'POST' && c.url.endsWith('/repos/acme/widgets/labels'))?.body,
    ).toMatchObject({ name: 'needs-moderation' });
    expect(calls.some((c) => c.url.endsWith('/graphql'))).toBe(false);
  });

  it('does nothing to an allowed comment, and never checks a maintainer', async () => {
    const allowed = fake('allow');
    expect(await run(env('issue_comment', comment).env, allowed.impl, () => {})).toBe(0);
    expect(allowed.calls.map((c) => c.url)).toEqual(['https://api.unprofane.com/v1/check/batch']);

    const member = fake('block');
    const byMember = {
      ...comment,
      comment: { ...comment.comment, author_association: 'MEMBER' },
    };
    expect(await run(env('issue_comment', byMember).env, member.impl, () => {})).toBe(0);
    expect(member.calls).toEqual([]);
  });

  it('fails the step when asked to, and when the API refuses the key', async () => {
    const { impl } = fake('block');
    expect(
      await run(env('issue_comment', comment, { 'INPUT_ON-BLOCK': 'fail' }).env, impl, () => {}),
    ).toBe(1);

    const refused = (async () =>
      new Response(JSON.stringify({ title: 'Invalid key', detail: 'the key is revoked' }), {
        status: 401,
        headers: { 'content-type': 'application/problem+json' },
      })) as unknown as typeof fetch;
    const lines: string[] = [];
    expect(await run(env('issue_comment', comment).env, refused, (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).toMatch(/::error::Unprofane could not check the issue comment: 401/);
  });

  it('labels a discussion through GraphQL', async () => {
    const { calls, impl } = fake('block');
    const discussion = {
      action: 'created',
      discussion: {
        node_id: 'D_5',
        title: 'Help',
        body: 'idiots',
        user: { login: 'troll', type: 'User' },
        author_association: 'NONE',
        html_url: 'u',
      },
    };
    expect(await run(env('discussion', discussion).env, impl, () => {})).toBe(0);
    const label = calls.find((c) => c.body?.query?.includes('addLabelsToLabelable'));
    expect(label?.body.variables).toEqual({ id: 'D_5', labels: ['LA_1'] });
  });
});
