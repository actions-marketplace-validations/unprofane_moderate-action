/**
 * The action: read the event's text, ask Unprofane, then hide, label,
 * reply or fail as the inputs say. The text itself is never logged.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { Unprofane, UnprofaneError } from '@unprofane/sdk';
import {
  type Answer,
  exemption,
  type Inputs,
  plan,
  prepare,
  readInputs,
  type Target,
  targetOf,
  verdictOf,
} from './moderate.ts';

type Env = Record<string, string | undefined>;

/** GitHub's REST and GraphQL APIs, with the action's token. */
export function githubClient(env: Env, token: string, fetchImpl: typeof fetch = fetch) {
  const rest = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
  const graphqlUrl = env.GITHUB_GRAPHQL_URL ?? `${rest}/graphql`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': 'unprofane-moderate-action',
    'x-github-api-version': '2022-11-28',
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetchImpl(`${rest}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok && res.status !== 404)
      throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 404 ? null : res.json();
  };
  const graphql = async (query: string, variables: Record<string, unknown>) => {
    const res = await fetchImpl(graphqlUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as { errors?: Array<{ message: string }>; data?: unknown };
    if (!res.ok || json.errors?.length)
      throw new Error(
        `GitHub GraphQL: ${res.status} ${json.errors?.map((e) => e.message).join('; ') ?? ''}`,
      );
    return json.data;
  };
  return { call, graphql };
}

type GitHub = ReturnType<typeof githubClient>;

async function labelId(gh: GitHub, repo: string, name: string): Promise<string> {
  const found = (await gh.call('GET', `/repos/${repo}/labels/${encodeURIComponent(name)}`)) as {
    node_id: string;
  } | null;
  if (found) return found.node_id;
  const made = (await gh.call('POST', `/repos/${repo}/labels`, {
    name,
    color: 'c92a2a',
    description: 'Flagged by Unprofane Comment Moderation',
  })) as { node_id: string };
  return made.node_id;
}

/** Take one step on the target. */
async function act(step: string, target: Target, inputs: Inputs, gh: GitHub, repo: string) {
  if (step === 'hide')
    await gh.graphql(
      'mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: ABUSE }) { minimizedComment { isMinimized } } }',
      { id: target.commentId },
    );
  else if (step === 'label') {
    if (target.number !== undefined) {
      await labelId(gh, repo, inputs.label);
      await gh.call('POST', `/repos/${repo}/issues/${target.number}/labels`, {
        labels: [inputs.label],
      });
    } else
      await gh.graphql(
        'mutation($id: ID!, $labels: [ID!]!) { addLabelsToLabelable(input: { labelableId: $id, labelIds: $labels }) { clientMutationId } }',
        { id: target.discussionId, labels: [await labelId(gh, repo, inputs.label)] },
      );
  } else if (step === 'reply') {
    if (target.number !== undefined)
      await gh.call('POST', `/repos/${repo}/issues/${target.number}/comments`, {
        body: inputs.reply,
      });
    else
      await gh.graphql(
        'mutation($id: ID!, $body: String!) { addDiscussionComment(input: { discussionId: $id, body: $body }) { clientMutationId } }',
        { id: target.discussionId, body: inputs.reply },
      );
  }
}

function output(env: Env, values: Record<string, string>) {
  if (!env.GITHUB_OUTPUT) return;
  for (const [k, v] of Object.entries(values)) appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

/** Run the action; the exit code. */
export async function run(
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
  log: (line: string) => void = console.log,
): Promise<number> {
  let inputs: Inputs;
  try {
    inputs = readInputs(env);
  } catch (e) {
    log(`::error::${(e as Error).message}`);
    return 1;
  }
  const payload = env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    : {};
  const target = targetOf(env.GITHUB_EVENT_NAME ?? '', payload);
  if (!target) {
    log(`Nothing to check on ${env.GITHUB_EVENT_NAME} (${payload.action ?? 'no action'}).`);
    output(env, { action: 'allow', categories: '', 'check-ids': '' });
    return 0;
  }
  const exempt = exemption(target, inputs);
  if (exempt) {
    log(`Not checked: ${exempt}.`);
    output(env, { action: 'allow', categories: '', 'check-ids': '' });
    return 0;
  }
  const texts = prepare(target.texts, inputs.checkCode);
  if (!texts.length) {
    log(`The ${target.kind} has no prose to check.`);
    output(env, { action: 'allow', categories: '', 'check-ids': '' });
    return 0;
  }

  const unprofane = new Unprofane(inputs.apiKey, {
    fetch: fetchImpl,
    ...(env.UNPROFANE_API_URL ? { baseUrl: env.UNPROFANE_API_URL } : {}),
  });
  let answers: Answer[];
  try {
    const results = await unprofane.checkMany(texts, {
      context: inputs.context as never,
      policy: inputs.policy as never,
      language: inputs.language as never,
    });
    answers = results.map((r) => {
      if ('error' in r)
        throw new Error(`${r.error.title}${r.error.detail ? `: ${r.error.detail}` : ''}`);
      return r.result as Answer;
    });
  } catch (e) {
    const detail =
      e instanceof UnprofaneError
        ? `${e.status} ${e.problem?.detail ?? e.message}${e.requestId ? ` (request ${e.requestId})` : ''}`
        : (e as Error).message;
    log(`::error::Unprofane could not check the ${target.kind}: ${detail}`);
    return 1;
  }

  const verdict = verdictOf(answers);
  const because = verdict.categories.length ? ` (${verdict.categories.join(', ')})` : '';
  log(
    `${verdict.action}${because}: the ${target.kind} by ${target.author}, ${target.url}. Checks: ${verdict.ids.join(', ')}`,
  );
  output(env, {
    action: verdict.action,
    categories: verdict.categories.join(','),
    'check-ids': verdict.ids.join(','),
  });
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `**${verdict.action}**${because}: the ${target.kind} by @${target.author}, ${target.url}\n`,
    );

  const { steps, skipped } = plan(verdict.action, target, inputs);
  for (const s of skipped) log(`::notice::Skipped ${s}.`);
  const gh = githubClient(env, inputs.githubToken, fetchImpl);
  const repo = env.GITHUB_REPOSITORY ?? '';
  let code = 0;
  for (const step of steps) {
    if (step === 'fail') {
      log(`::error::The ${target.kind} was answered ${verdict.action}${because}.`);
      code = 1;
      continue;
    }
    try {
      await act(step, target, inputs, gh, repo);
      log(`Done: ${step}.`);
    } catch (e) {
      log(`::error::${step} failed: ${(e as Error).message}`);
      code = 1;
    }
  }
  return code;
}
