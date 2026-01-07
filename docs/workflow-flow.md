# CI/CD Automation Flow (Visio-style)

Below is a high-level flow diagram (Mermaid) showing how the system moves from Jira tickets → Pull Requests → GitHub Actions → Azure → Jira updates, including monitoring and reconciliation on server restarts.

```mermaid
flowchart TD
  %% Swimlanes via subgraphs
  subgraph JIRA[Jira Cloud]
    J1[Ticket in To Do]
    J2[Transition to In Progress]
    J3[Post PR created]
    J4[Post Ready for Review]
    J5[Post Deployment Success/Failure]
    J6[Transition to Done / To Do]
  end

  subgraph SERVER[Automation Server]
    S0[Startup]
    S1[Poll Jira for To Do]
    S2[Process Ticket Data]
    S3[Analyze Repo & Detect Language]
    S4[Generate Workflow YAML]
    S5[Ensure Feature Branch]
    S6["Upsert Files (Workflow / Dockerfile)"]
    S7[Create or Reuse PR]
    S8[Comment PR with Copilot Prompt]
    S9[Monitor Runs & Jobs]
    S10[Summarize Failures + Hints]
    S11[Reconcile Active PRs on Restart]
  end

  subgraph GITHUB[GitHub]
    G1[PR Open]
    G2[PR Updates]
    G3[Deployment created with environment_url]
  end

  subgraph ACTIONS[GitHub Actions]
    A1[Build & Test]
    A2["Security Scan (CodeQL)"]
    A3{Container Build?}
    A4[Docker Build & Push]
    A5{Deploy to Azure?}
    A6[Prepare Static Package]
    A7[Validate index.html]
    A8[Deploy to Azure Web App]
    A9[Publish Deployment URL]
  end

  subgraph AZURE[Azure Web App]
    Z1[App/Slot Updated]
    Z2[Live URL]
  end

  %% Main happy path
  J1 -->|Autopilot poll| S1 --> S2 --> S3 --> S4 --> S5 --> S6 --> S7 --> G1
  S2 -->|Transition| J2
  S7 -->|Comment PR| S8 --> G2
  G1 -->|Triggers| A1 --> A2 --> A3
  A3 -- yes --> A4 --> A5
  A3 -- no --> A5
  A5 -- yes --> A6 --> A7 --> A8 --> Z1 --> Z2 --> A9 --> G3 --> S9
  A5 -- no --> S9

  %% Monitoring and outcomes
  S9 -->|Success| J5 --> J6
  S9 -->|Failure| S10 --> J5 --> J6

  %% Reconciliation on restart
  S0 --> S11 -->|Org PRs + Jira keys| S9
```

Key Notes
- Build/Test defaults when missing: `npm run build` / `npm test`.
- Static-site deploys package only `public/` or a minimal `deploy/` folder; validates `index.html`.
- Deployment URL published via GitHub Deployments and included in Jira comments.
- On restart, the server reconciles open org PRs → seeds monitoring for tickets in active statuses.

How to View
- GitHub renders Mermaid diagrams natively in Markdown.
- In VS Code: open docs/workflow-flow.md and use “Open Preview”.
