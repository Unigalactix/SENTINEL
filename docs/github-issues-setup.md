# GitHub Issues Setup for SENTINEL

## Required Labels

Create the following labels in your issues repository:

| Label | Color | Purpose |
|-------|-------|---------|
| `sentinel:todo` | `#0075ca` | Issues ready to be picked up |
| `sentinel:in-progress` | `#e4e669` | Agent is currently processing |
| `sentinel:failed` | `#d73a4a` | Agent encountered an error |
| `priority:highest` | `#b60205` | Critical priority |
| `priority:high` | `#d93f0b` | High priority |
| `priority:medium` | `#fbca04` | Medium priority |
| `priority:low` | `#0e8a16` | Low priority |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_ISSUES_REPO` | ✅ Yes | `owner/repo` to poll issues from |
| `GITHUB_ISSUES_LABEL` | No | Label for pending issues (default: `sentinel:todo`) |

## Issue Body Format

Use these directives in the issue body to configure the agent:

```
**repo:** Unigalactix/my-target-repo
**language:** node
**build:** npm run build
**test:** npm test
**deploy:** azure-webapp

Describe what needs to be done here...
```

## Migrating from Jira

1. Remove secrets: `JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN`
2. Add secrets: `GITHUB_ISSUES_REPO`, optionally `GITHUB_ISSUES_LABEL`
3. Create the labels above in your issues repository
4. Re-open/create issues in GitHub with the `sentinel:todo` label
