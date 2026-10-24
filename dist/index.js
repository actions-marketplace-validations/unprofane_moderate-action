import { appendFileSync, readFileSync } from "node:fs";

var UnprofaneError = class extends Error {
  status;
  problem;
  requestId;
  constructor(message, status, problem, requestId) {
    super(message);
    this.name = "UnprofaneError";
    this.status = status;
    this.problem = problem;
    this.requestId = requestId;
  }
};
var RETRYABLE = /* @__PURE__ */ new Set([429, 502, 503, 504]);
var MAX_BATCH = 100;
var MAX_BATCH_CHARS = 3e4;
var charsOf = (items) => items.reduce((n, i) => n + i.text.length, 0);
var SDK_VERSION = "0.1.6";
var Unprofane = class {
  apiKey;
  baseUrl;
  retries;
  timeoutMs;
  fetchImpl;
  constructor(apiKey, options = {}) {
    if (!apiKey || !/^up_(live|test|pk)_/.test(apiKey))
      throw new TypeError("Unprofane: pass an API key (up_live_\u2026, up_test_\u2026 or up_pk_\u2026)");
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.unprofane.com").replace(/\/+$/, "");
    this.retries = options.retries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 1e4;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  /** One text: should it be allowed, with the evidence. */
  check(request) {
    return this.call("POST", "/v1/check", request);
  }
  /** Up to 100 items with ids, 30,000 characters in all, answered in order. */
  checkBatch(request) {
    if (request.items.length > MAX_BATCH)
      throw new RangeError(`checkBatch takes at most ${MAX_BATCH} items; use checkMany`);
    if (charsOf(request.items) > MAX_BATCH_CHARS)
      throw new RangeError(
        `checkBatch takes at most ${MAX_BATCH_CHARS} characters of text; use checkMany`
      );
    return this.call("POST", "/v1/check/batch", request);
  }
  /**
   * Any number of texts: chunked into batches of up to 100 texts and 30,000
   * characters, `concurrency` batches in flight (default 2), results in
   * input order. A text longer than a batch holds goes alone and is refused.
   * A chunk that fails after its retries throws; the chunks already
   * answered are lost with it, so keep a chunk's worth of texts per call
   * where that matters.
   */
  async checkMany(texts2, options = {}) {
    const { concurrency = 2, ...rest } = options;
    const chunks = [];
    let chunk = [];
    let chars = 0;
    texts2.forEach((text, i) => {
      if (chunk.length === MAX_BATCH || chunk.length > 0 && chars + text.length > MAX_BATCH_CHARS) {
        chunks.push(chunk);
        chunk = [];
        chars = 0;
      }
      chunk.push({ id: String(i), text });
      chars += text.length;
    });
    if (chunk.length) chunks.push(chunk);
    const out = new Array(chunks.length);
    let next = 0;
    const worker = async () => {
      for (; ; ) {
        const i = next++;
        if (i >= chunks.length) return;
        out[i] = (await this.checkBatch({ ...rest, items: chunks[i] })).results;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
    return out.flat();
  }
  /** Report a wrong result. `text` is stored with your account only if you include it. */
  feedback(request) {
    return this.call("POST", "/v1/feedback", request);
  }
  /** This period's usage for the key's account. */
  usage() {
    return this.call("GET", "/v1/usage");
  }
  /** The key's project lists: read, replace, empty. */
  getList(projectId, kind) {
    return this.call("GET", `/v1/projects/${encodeURIComponent(projectId)}/lists/${kind}`);
  }
  putList(projectId, kind, terms) {
    return this.call("PUT", `/v1/projects/${encodeURIComponent(projectId)}/lists/${kind}`, {
      terms
    });
  }
  async deleteList(projectId, kind) {
    await this.call("DELETE", `/v1/projects/${encodeURIComponent(projectId)}/lists/${kind}`);
  }
  async call(method, path, body) {
    let attempt = 0;
    for (; ; ) {
      let res;
      try {
        const fetchImpl = this.fetchImpl;
        res = await fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "user-agent": `unprofane-sdk-js/${SDK_VERSION}`,
            ...body !== void 0 ? { "content-type": "application/json" } : {}
          },
          ...body !== void 0 ? { body: JSON.stringify(body) } : {},
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (error) {
        if (attempt++ >= this.retries) throw error;
        await sleep(backoff(attempt, null));
        continue;
      }
      if (res.ok) return res.status === 204 ? null : await res.json();
      const requestId = res.headers.get("request-id");
      const problem = await readProblem(res);
      if (RETRYABLE.has(res.status) && attempt++ < this.retries) {
        await sleep(backoff(attempt, res.headers.get("retry-after")));
        continue;
      }
      throw new UnprofaneError(
        problem?.detail ?? problem?.title ?? `Unprofane ${method} ${path} failed (${res.status})`,
        res.status,
        problem,
        requestId
      );
    }
  }
};
async function readProblem(res) {
  try {
    const json = await res.json();
    if (json && typeof json.title === "string")
      return { ...json, status: json.status ?? res.status };
  } catch {
  }
  return null;
}
function backoff(attempt, retryAfter) {
  const header = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(header) && header >= 0) return Math.min(header * 1e3, 3e4);
  const cap = Math.min(8e3, 250 * 2 ** attempt);
  return Math.random() * cap;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));

var STEPS = ["hide", "label", "reply", "fail"];
var list = (raw) => (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
function steps(raw, name) {
  const out = list(raw).map((s) => s.toLowerCase());
  const unknown = out.filter((s) => !STEPS.includes(s));
  if (unknown.length)
    throw new Error(`${name}: unknown step ${unknown.join(", ")}; use ${STEPS.join(", ")}`);
  return out;
}
function readInputs(env) {
  const input = (name) => env[`INPUT_${name.toUpperCase()}`]?.trim() ?? "";
  const apiKey = input("api-key");
  if (!apiKey) throw new Error("api-key is empty: pass secrets.UNPROFANE_API_KEY");
  return {
    apiKey,
    githubToken: input("github-token"),
    policy: input("policy") || "standard",
    context: input("context") || "comment",
    language: input("language") || "auto",
    onBlock: steps(input("on-block") || "hide,label", "on-block"),
    onReview: steps(input("on-review") || "label", "on-review"),
    label: input("label") || "needs-moderation",
    reply: input("reply"),
    exemptAssociations: list(input("exempt-associations")).map((s) => s.toUpperCase()),
    exemptBots: input("exempt-bots") !== "false",
    checkCode: input("check-code") === "true"
  };
}
var who = (user) => ({
  author: user?.login ?? "ghost",
  isBot: user?.type === "Bot" || /\[bot\]$/.test(user?.login ?? "")
});
var texts = (...parts) => parts.filter((p) => typeof p === "string");
function targetOf(eventName, payload) {
  if (payload.action === "deleted") return null;
  switch (eventName) {
    case "issues": {
      const issue = payload.issue;
      if (!issue || !["opened", "edited", "reopened"].includes(payload.action ?? "")) return null;
      return {
        kind: "issue",
        texts: texts(issue.title, issue.body),
        number: issue.number,
        association: issue.author_association ?? "NONE",
        url: issue.html_url ?? "",
        ...who(issue.user)
      };
    }
    case "pull_request":
    case "pull_request_target": {
      const pr = payload.pull_request;
      if (!pr || !["opened", "edited", "reopened"].includes(payload.action ?? "")) return null;
      return {
        kind: "pull request",
        texts: texts(pr.title, pr.body),
        number: pr.number,
        association: pr.author_association ?? "NONE",
        url: pr.html_url ?? "",
        ...who(pr.user)
      };
    }
    case "issue_comment": {
      const c = payload.comment;
      if (!c) return null;
      return {
        kind: "issue comment",
        texts: texts(c.body),
        commentId: c.node_id,
        number: payload.issue?.number,
        association: c.author_association ?? "NONE",
        url: c.html_url ?? "",
        ...who(c.user)
      };
    }
    case "pull_request_review_comment": {
      const c = payload.comment;
      if (!c) return null;
      return {
        kind: "review comment",
        texts: texts(c.body),
        commentId: c.node_id,
        number: payload.pull_request?.number,
        association: c.author_association ?? "NONE",
        url: c.html_url ?? "",
        ...who(c.user)
      };
    }
    case "pull_request_review": {
      const r = payload.review;
      if (!r?.body) return null;
      return {
        kind: "review",
        texts: texts(r.body),
        number: payload.pull_request?.number,
        association: r.author_association ?? "NONE",
        url: r.html_url ?? "",
        ...who(r.user)
      };
    }
    case "discussion": {
      const d = payload.discussion;
      if (!d || !["created", "edited"].includes(payload.action ?? "")) return null;
      return {
        kind: "discussion",
        texts: texts(d.title, d.body),
        discussionId: d.node_id,
        association: d.author_association ?? "NONE",
        url: d.html_url ?? "",
        ...who(d.user)
      };
    }
    case "discussion_comment": {
      const c = payload.comment;
      if (!c) return null;
      return {
        kind: "discussion comment",
        texts: texts(c.body),
        commentId: c.node_id,
        discussionId: payload.discussion?.node_id,
        association: c.author_association ?? "NONE",
        url: c.html_url ?? "",
        ...who(c.user)
      };
    }
    default:
      return null;
  }
}
function exemption(target, inputs) {
  if (inputs.exemptBots && target.isBot) return `${target.author} is a bot`;
  if (inputs.exemptAssociations.includes(target.association.toUpperCase()))
    return `${target.author} is a ${target.association.toLowerCase()} of the repository`;
  return null;
}
var MAX_TEXT_CHARS = 1e4;
function prepare(raw, checkCode) {
  const out = [];
  for (const text of raw) {
    let t = text.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
    if (!checkCode) t = t.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "");
    t = t.split("\n").filter((line) => !/^\s*>/.test(line)).join("\n");
    if (!checkCode) t = t.replace(/`[^`\n]+`/g, "");
    t = t.replace(/\n{3,}/g, "\n\n").trim();
    if (t) out.push(...split(t));
  }
  return out;
}
function split(text) {
  if (text.length <= MAX_TEXT_CHARS) return [text];
  const pieces = [];
  let rest = text;
  while (rest.length > MAX_TEXT_CHARS) {
    const cut = rest.lastIndexOf("\n", MAX_TEXT_CHARS);
    const at = cut > MAX_TEXT_CHARS / 2 ? cut : rest.lastIndexOf(" ", MAX_TEXT_CHARS);
    const end = at > 0 ? at : MAX_TEXT_CHARS;
    pieces.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
}
var RANK = { allow: 0, review: 1, block: 2 };
function verdictOf(answers) {
  let action = "allow";
  for (const a of answers) if (RANK[a.action] > RANK[action]) action = a.action;
  const categories = [
    ...new Set(
      answers.filter((a) => a.action === action).flatMap((a) => a.decided_by.map((d) => d.category))
    )
  ];
  return {
    action,
    categories: action === "allow" ? [] : categories,
    ids: answers.map((a) => a.id)
  };
}
function plan(verdict, target, inputs) {
  const wanted = verdict === "block" ? inputs.onBlock : verdict === "review" ? inputs.onReview : [];
  const steps2 = [];
  const skipped = [];
  const onThread = target.number !== void 0 || target.discussionId !== void 0;
  for (const step of wanted) {
    if (step === "hide" && !target.commentId)
      skipped.push(`hide: only a comment can be hidden, not the ${target.kind}`);
    else if ((step === "label" || step === "reply") && !onThread)
      skipped.push(`${step}: no issue, pull request or discussion to put it on`);
    else if (step === "reply" && !inputs.reply) skipped.push("reply: the reply input is empty");
    else if (!steps2.includes(step)) steps2.push(step);
  }
  return { steps: steps2, skipped };
}

function githubClient(env, token, fetchImpl = fetch) {
  const rest = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
  const graphqlUrl = env.GITHUB_GRAPHQL_URL ?? `${rest}/graphql`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "unprofane-moderate-action",
    "x-github-api-version": "2022-11-28"
  };
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${rest}${path}`, {
      method,
      headers,
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    });
    if (!res.ok && res.status !== 404)
      throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 404 ? null : res.json();
  };
  const graphql = async (query, variables) => {
    const res = await fetchImpl(graphqlUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables })
    });
    const json = await res.json();
    if (!res.ok || json.errors?.length)
      throw new Error(
        `GitHub GraphQL: ${res.status} ${json.errors?.map((e) => e.message).join("; ") ?? ""}`
      );
    return json.data;
  };
  return { call, graphql };
}
async function labelId(gh, repo, name) {
  const found = await gh.call("GET", `/repos/${repo}/labels/${encodeURIComponent(name)}`);
  if (found) return found.node_id;
  const made = await gh.call("POST", `/repos/${repo}/labels`, {
    name,
    color: "c92a2a",
    description: "Flagged by Unprofane Comment Moderation"
  });
  return made.node_id;
}
async function act(step, target, inputs, gh, repo) {
  if (step === "hide")
    await gh.graphql(
      "mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: ABUSE }) { minimizedComment { isMinimized } } }",
      { id: target.commentId }
    );
  else if (step === "label") {
    if (target.number !== void 0) {
      await labelId(gh, repo, inputs.label);
      await gh.call("POST", `/repos/${repo}/issues/${target.number}/labels`, {
        labels: [inputs.label]
      });
    } else
      await gh.graphql(
        "mutation($id: ID!, $labels: [ID!]!) { addLabelsToLabelable(input: { labelableId: $id, labelIds: $labels }) { clientMutationId } }",
        { id: target.discussionId, labels: [await labelId(gh, repo, inputs.label)] }
      );
  } else if (step === "reply") {
    if (target.number !== void 0)
      await gh.call("POST", `/repos/${repo}/issues/${target.number}/comments`, {
        body: inputs.reply
      });
    else
      await gh.graphql(
        "mutation($id: ID!, $body: String!) { addDiscussionComment(input: { discussionId: $id, body: $body }) { clientMutationId } }",
        { id: target.discussionId, body: inputs.reply }
      );
  }
}
function output(env, values) {
  if (!env.GITHUB_OUTPUT) return;
  for (const [k, v] of Object.entries(values)) appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}
`);
}
async function run(env = process.env, fetchImpl = fetch, log = console.log) {
  let inputs;
  try {
    inputs = readInputs(env);
  } catch (e) {
    log(`::error::${e.message}`);
    return 1;
  }
  const payload = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  const target = targetOf(env.GITHUB_EVENT_NAME ?? "", payload);
  if (!target) {
    log(`Nothing to check on ${env.GITHUB_EVENT_NAME} (${payload.action ?? "no action"}).`);
    output(env, { action: "allow", categories: "", "check-ids": "" });
    return 0;
  }
  const exempt = exemption(target, inputs);
  if (exempt) {
    log(`Not checked: ${exempt}.`);
    output(env, { action: "allow", categories: "", "check-ids": "" });
    return 0;
  }
  const texts2 = prepare(target.texts, inputs.checkCode);
  if (!texts2.length) {
    log(`The ${target.kind} has no prose to check.`);
    output(env, { action: "allow", categories: "", "check-ids": "" });
    return 0;
  }
  const unprofane = new Unprofane(inputs.apiKey, {
    fetch: fetchImpl,
    ...env.UNPROFANE_API_URL ? { baseUrl: env.UNPROFANE_API_URL } : {}
  });
  let answers;
  try {
    const results = await unprofane.checkMany(texts2, {
      context: inputs.context,
      policy: inputs.policy,
      language: inputs.language
    });
    answers = results.map((r) => {
      if ("error" in r)
        throw new Error(`${r.error.title}${r.error.detail ? `: ${r.error.detail}` : ""}`);
      return r.result;
    });
  } catch (e) {
    const detail = e instanceof UnprofaneError ? `${e.status} ${e.problem?.detail ?? e.message}${e.requestId ? ` (request ${e.requestId})` : ""}` : e.message;
    log(`::error::Unprofane could not check the ${target.kind}: ${detail}`);
    return 1;
  }
  const verdict = verdictOf(answers);
  const because = verdict.categories.length ? ` (${verdict.categories.join(", ")})` : "";
  log(
    `${verdict.action}${because}: the ${target.kind} by ${target.author}, ${target.url}. Checks: ${verdict.ids.join(", ")}`
  );
  output(env, {
    action: verdict.action,
    categories: verdict.categories.join(","),
    "check-ids": verdict.ids.join(",")
  });
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `**${verdict.action}**${because}: the ${target.kind} by @${target.author}, ${target.url}
`
    );
  const { steps: steps2, skipped } = plan(verdict.action, target, inputs);
  for (const s of skipped) log(`::notice::Skipped ${s}.`);
  const gh = githubClient(env, inputs.githubToken, fetchImpl);
  const repo = env.GITHUB_REPOSITORY ?? "";
  let code = 0;
  for (const step of steps2) {
    if (step === "fail") {
      log(`::error::The ${target.kind} was answered ${verdict.action}${because}.`);
      code = 1;
      continue;
    }
    try {
      await act(step, target, inputs, gh, repo);
      log(`Done: ${step}.`);
    } catch (e) {
      log(`::error::${step} failed: ${e.message}`);
      code = 1;
    }
  }
  return code;
}

process.exitCode = await run();
