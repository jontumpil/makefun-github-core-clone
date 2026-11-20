# makefun-github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jontumpil/makefun-github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jontumpil/makefun-github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only: git smart HTTP
(protocol v2 ls-refs/fetch, v0 fetch, receive-pack with report-status) over an in-memory
content-addressed object store, the REST v3 resources (repositories, branches, commits, contents,
labels, issues, comments, pull requests with squash merges), the GraphQL v4 documents `gh` sends,
and an MCP endpoint (server/discover + the legacy handshake, six tools) — every surface reading
and writing the same store, so an object created through one is the same object on the others.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=w7fy1fnp&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
