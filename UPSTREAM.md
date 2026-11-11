# PowerA upstream tracking

| Field | Value |
| --- | --- |
| Origin | https://github.com/ahmedtohamy1/powerk |
| Default branch | master |
| Pinned upstream commit | `4b3e82ec4ee5c80735924f8053ca0427913e6b2b` |
| Incorporation method | Git submodule reference only (not redistributed code) |
| Upstream license | No LICENSE found at time of review |
| PowerA work branch | `PowerA` |

To check upstream updates:

```bash
git submodule update --init
git -C upstream/powerk fetch origin master
git -C upstream/powerk log --oneline --max-count=10
```

**Never silently copy unlicensed upstream code into this repository**; agree on reuse permissions first.
