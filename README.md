# Unprofane Comment Moderation

A GitHub Action that reads each new issue, pull request, review and discussion comment with the [Unprofane](https://unprofane.com) profanity and toxicity API, hides the ones it blocks, and labels the ones a person should look at. It reads disguised abuse (`f.u.c.k`, `sh1t`, Cyrillic look-alikes, spaced letters) and passes innocent words that contain a bad one (Scunthorpe, Essex, assassin).

```yaml
# .github/workflows/moderate.yml
name: moderate
on:
  issues: { types: [opened, edited] }
  issue_comment: { types: [created, edited] }
  pull_request_target: { types: [opened, edited] }
  pull_request_review_comment: { types: [created, edited] }
  discussion: { types: [created, edited] }
  discussion_comment: { types: [created, edited] }

permissions:
  issues: write
  pull-requests: write
  discussions: write

jobs:
  moderate:
    runs-on: ubuntu-latest
    steps:
      - uses: unprofane/moderate-action@v1
        with:
          api-key: ${{ secrets.UNPROFANE_API_KEY }}
```

`pull_request_target` runs in the base repository, so a fork's pull request gets the secret; the action never checks out the pull request's code.

## What it does

| The API answers | Default | Choices |
|---|---|---|
| `block` | hide the comment, add the `needs-moderation` label | `on-block`: any of `hide`, `label`, `reply`, `fail` |
| `review` | add the label | `on-review`: the same choices |
| `allow` | nothing | |

`hide` minimizes a comment as abuse, the way a maintainer would from the comment's menu, so anyone with write access can show it again. An issue, pull request or discussion body cannot be hidden, so it is labeled. Owners, members and collaborators are not checked, nor are bots (`exempt-associations`, `exempt-bots`). Quoted replies, HTML comments from issue templates and code are left out of the text (`check-code: true` reads code too).

## Inputs

| Input | Default | |
|---|---|---|
| `api-key` | required | An Unprofane key, from a secret |
| `github-token` | `github.token` | Hides, labels and replies |
| `policy` | `standard` | `kids`, `teen`, `standard`, `strict` or `casual` |
| `context` | `comment` | What the text is, for the API |
| `language` | `auto` | A language code, or `auto` |
| `on-block` | `hide,label` | Steps for a block |
| `on-review` | `label` | Steps for a review |
| `label` | `needs-moderation` | Created when missing |
| `reply` | a one-line note | Posted by the `reply` step |
| `exempt-associations` | `OWNER,MEMBER,COLLABORATOR` | Empty checks everyone |
| `exempt-bots` | `true` | |
| `check-code` | `false` | |

Outputs: `action` (`allow`, `review` or `block`), `categories` (what decided it, such as `slur` or `insult`) and `check-ids` (for reporting a wrong answer with `/v1/feedback`).

## The key and the text

Make a key at [unprofane.com](https://unprofane.com/app/) and save it as the `UNPROFANE_API_KEY` secret. A test key (`up_test_…`) works without a plan, capped per day; a live key needs a plan, from $9 a month for 25,000 checks ([pricing](https://unprofane.com/pricing/)). Each text sent is one check.

The action logs the verdict, the categories and the check ids, never the text. Texts the model reads are kept for 90 days to improve the engine, with no account, key or address beside them ([privacy](https://unprofane.com/legal/privacy/)).

MIT licensed. Built from `src/` with `npm run build`; `dist/index.js` is the bundle the runner loads.
