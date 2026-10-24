/**
 * What the action reads from a GitHub event and what it does with the
 * API's answer, with no I/O: main.ts calls GitHub and Unprofane.
 */

export const STEPS = ['hide', 'label', 'reply', 'fail'] as const;
export type Step = (typeof STEPS)[number];
export type Verdict = 'allow' | 'review' | 'block';

export interface Inputs {
  apiKey: string;
  githubToken: string;
  policy: string;
  context: string;
  language: string;
  onBlock: Step[];
  onReview: Step[];
  label: string;
  reply: string;
  exemptAssociations: string[];
  exemptBots: boolean;
  checkCode: boolean;
}

/** The text an event carries, and where a step acts on it. */
export interface Target {
  /** What the text is, for the log and the summary. */
  kind:
    | 'issue'
    | 'pull request'
    | 'issue comment'
    | 'review comment'
    | 'review'
    | 'discussion'
    | 'discussion comment';
  /** The title and the body as written; main.ts prepares them. */
  texts: string[];
  /** A comment's node id: the hide step needs one. */
  commentId?: string;
  /** The issue or pull request number that a label and a reply go on. */
  number?: number;
  /** The discussion's node id that a label and a reply go on. */
  discussionId?: string;
  author: string;
  association: string;
  isBot: boolean;
  url: string;
}

const list = (raw: string | undefined) =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function steps(raw: string | undefined, name: string): Step[] {
  const out = list(raw).map((s) => s.toLowerCase());
  const unknown = out.filter((s) => !(STEPS as readonly string[]).includes(s));
  if (unknown.length)
    throw new Error(`${name}: unknown step ${unknown.join(', ')}; use ${STEPS.join(', ')}`);
  return out as Step[];
}

/** The action's inputs, from the INPUT_* variables the runner sets. */
export function readInputs(env: Record<string, string | undefined>): Inputs {
  const input = (name: string) => env[`INPUT_${name.toUpperCase()}`]?.trim() ?? '';
  const apiKey = input('api-key');
  if (!apiKey) throw new Error('api-key is empty: pass secrets.UNPROFANE_API_KEY');
  return {
    apiKey,
    githubToken: input('github-token'),
    policy: input('policy') || 'standard',
    context: input('context') || 'comment',
    language: input('language') || 'auto',
    onBlock: steps(input('on-block') || 'hide,label', 'on-block'),
    onReview: steps(input('on-review') || 'label', 'on-review'),
    label: input('label') || 'needs-moderation',
    reply: input('reply'),
    exemptAssociations: list(input('exempt-associations')).map((s) => s.toUpperCase()),
    exemptBots: input('exempt-bots') !== 'false',
    checkCode: input('check-code') === 'true',
  };
}

type Author = { login?: string; type?: string } | null | undefined;
/** The fields of an issue, pull request, comment, review or discussion the action reads. */
interface Written {
  node_id?: string;
  number?: number;
  title?: string | null;
  body?: string | null;
  user?: Author;
  author_association?: string;
  html_url?: string;
}
/** The event payload, as far as the action reads it. */
export interface Payload {
  action?: string;
  issue?: Written;
  pull_request?: Written;
  comment?: Written;
  review?: Written;
  discussion?: Written;
}

const who = (user: Author) => ({
  author: user?.login ?? 'ghost',
  isBot: user?.type === 'Bot' || /\[bot\]$/.test(user?.login ?? ''),
});
const texts = (...parts: Array<string | null | undefined>) =>
  parts.filter((p): p is string => typeof p === 'string');

/** The text an event carries, or null for an event or action that has none to check. */
export function targetOf(eventName: string, payload: Payload): Target | null {
  if (payload.action === 'deleted') return null;
  switch (eventName) {
    case 'issues': {
      const issue = payload.issue;
      if (!issue || !['opened', 'edited', 'reopened'].includes(payload.action ?? '')) return null;
      return {
        kind: 'issue',
        texts: texts(issue.title, issue.body),
        number: issue.number,
        association: issue.author_association ?? 'NONE',
        url: issue.html_url ?? '',
        ...who(issue.user),
      };
    }
    case 'pull_request':
    case 'pull_request_target': {
      const pr = payload.pull_request;
      if (!pr || !['opened', 'edited', 'reopened'].includes(payload.action ?? '')) return null;
      return {
        kind: 'pull request',
        texts: texts(pr.title, pr.body),
        number: pr.number,
        association: pr.author_association ?? 'NONE',
        url: pr.html_url ?? '',
        ...who(pr.user),
      };
    }
    case 'issue_comment': {
      const c = payload.comment;
      if (!c) return null;
      return {
        kind: 'issue comment',
        texts: texts(c.body),
        commentId: c.node_id,
        number: payload.issue?.number,
        association: c.author_association ?? 'NONE',
        url: c.html_url ?? '',
        ...who(c.user),
      };
    }
    case 'pull_request_review_comment': {
      const c = payload.comment;
      if (!c) return null;
      return {
        kind: 'review comment',
        texts: texts(c.body),
        commentId: c.node_id,
        number: payload.pull_request?.number,
        association: c.author_association ?? 'NONE',
        url: c.html_url ?? '',
        ...who(c.user),
      };
    }
    case 'pull_request_review': {
      const r = payload.review;
      if (!r?.body) return null;
      return {
        kind: 'review',
        texts: texts(r.body),
        number: payload.pull_request?.number,
        association: r.author_association ?? 'NONE',
        url: r.html_url ?? '',
        ...who(r.user),
      };
    }
    case 'discussion': {
      const d = payload.discussion;
      if (!d || !['created', 'edited'].includes(payload.action ?? '')) return null;
      return {
        kind: 'discussion',
        texts: texts(d.title, d.body),
        discussionId: d.node_id,
        association: d.author_association ?? 'NONE',
        url: d.html_url ?? '',
        ...who(d.user),
      };
    }
    case 'discussion_comment': {
      const c = payload.comment;
      if (!c) return null;
      return {
        kind: 'discussion comment',
        texts: texts(c.body),
        commentId: c.node_id,
        discussionId: payload.discussion?.node_id,
        association: c.author_association ?? 'NONE',
        url: c.html_url ?? '',
        ...who(c.user),
      };
    }
    default:
      return null;
  }
}

/** Why a target is not checked, or null when it is. */
export function exemption(target: Target, inputs: Inputs): string | null {
  if (inputs.exemptBots && target.isBot) return `${target.author} is a bot`;
  if (inputs.exemptAssociations.includes(target.association.toUpperCase()))
    return `${target.author} is a ${target.association.toLowerCase()} of the repository`;
  return null;
}

/** The most characters the API reads in one text. */
export const MAX_TEXT_CHARS = 10_000;

/**
 * The words a person wrote: without HTML comments (issue templates), quoted
 * replies (someone else's words), and, unless `checkCode`, code blocks and
 * inline code. Each text is split at line ends into pieces the API takes.
 */
export function prepare(raw: string[], checkCode: boolean): string[] {
  const out: string[] = [];
  for (const text of raw) {
    let t = text.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
    if (!checkCode) t = t.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '');
    t = t
      .split('\n')
      .filter((line) => !/^\s*>/.test(line))
      .join('\n');
    if (!checkCode) t = t.replace(/`[^`\n]+`/g, '');
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    if (t) out.push(...split(t));
  }
  return out;
}

function split(text: string): string[] {
  if (text.length <= MAX_TEXT_CHARS) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > MAX_TEXT_CHARS) {
    const cut = rest.lastIndexOf('\n', MAX_TEXT_CHARS);
    const at = cut > MAX_TEXT_CHARS / 2 ? cut : rest.lastIndexOf(' ', MAX_TEXT_CHARS);
    const end = at > 0 ? at : MAX_TEXT_CHARS;
    pieces.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
}

/** One answer from the API, the fields the action reads. */
export interface Answer {
  id: string;
  action: Verdict;
  decided_by: Array<{ category: string }>;
}

const RANK: Record<Verdict, number> = { allow: 0, review: 1, block: 2 };

/** The strictest answer, and the categories that decided it. */
export function verdictOf(answers: Answer[]): {
  action: Verdict;
  categories: string[];
  ids: string[];
} {
  let action: Verdict = 'allow';
  for (const a of answers) if (RANK[a.action] > RANK[action]) action = a.action;
  const categories = [
    ...new Set(
      answers
        .filter((a) => a.action === action)
        .flatMap((a) => a.decided_by.map((d) => d.category)),
    ),
  ];
  return {
    action,
    categories: action === 'allow' ? [] : categories,
    ids: answers.map((a) => a.id),
  };
}

/** The steps to take for a verdict, the ones that cannot apply to this target left out with why. */
export function plan(
  verdict: Verdict,
  target: Target,
  inputs: Inputs,
): { steps: Step[]; skipped: string[] } {
  const wanted = verdict === 'block' ? inputs.onBlock : verdict === 'review' ? inputs.onReview : [];
  const steps: Step[] = [];
  const skipped: string[] = [];
  const onThread = target.number !== undefined || target.discussionId !== undefined;
  for (const step of wanted) {
    if (step === 'hide' && !target.commentId)
      skipped.push(`hide: only a comment can be hidden, not the ${target.kind}`);
    else if ((step === 'label' || step === 'reply') && !onThread)
      skipped.push(`${step}: no issue, pull request or discussion to put it on`);
    else if (step === 'reply' && !inputs.reply) skipped.push('reply: the reply input is empty');
    else if (!steps.includes(step)) steps.push(step);
  }
  return { steps, skipped };
}
