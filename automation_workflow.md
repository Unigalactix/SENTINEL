# Automation Service Workflow

This document outlines the end-to-end workflow of the Jira Autopilot Service.

## System Architecture

The service bridges Jira and GitHub using a Node.js middleware.

```mermaid
sequenceDiagram
    participant User
    participant Jira
    participant Autopilot (Node.js)
    participant GitHub
    
    User->>Jira: Create Ticket (Status: To Do)
    Note over Jira: Fields: Repo, Language, Build Cmd
    
    loop Every 30 Seconds
        Autopilot->>Jira: Search JQL (statusCategory="To Do")
        Jira-->>Autopilot: Return Ticket List
        
        Autopilot->>Autopilot: Sort by Priority (High -> Low)
        
        loop For Each Ticket
            Autopilot->>Jira: Transition to "In Progress"
            
            Autopilot->>GitHub: GET /repos/... (Check Default Branch)
            Autopilot->>GitHub: POST /git/refs (Create Feature Branch)
            Autopilot->>GitHub: PUT /contents (Commit File)
            Autopilot->>GitHub: POST /pulls (Create Pull Request)
            
            alt Success
                Autopilot->>Jira: Add Comment (Success + PR Link)
                Autopilot->>Jira: Transition to "Done"
            else Failure
                Autopilot->>Jira: Add Comment (Error Details)
            end
        end
    end
```

## Generated Workflow Example

For a Jira ticket specifying:
- **Language**: `node`
- **Repo**: `Unigalactix/sample-node-project`
- **Build**: `npm run build`

The service generates a **Pull Request** which adds the following `.yml` file:

```yaml
name: CI Pipeline - Unigalactix/sample-node-project
on:
  push:
    branches: [ "main" ]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      # Dynamic Language Setup
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install dependencies
        run: npm ci
      
      - name: Running NPM Audit
        run: |
          if [ -f "package-lock.json" ]; then
            npm audit --production --json || true
          fi

      # Custom Commands from Jira
      - name: Build
        run: npm run build
      - name: Test
        run: npm test
```
