# Workflow Flow Diagram

This diagram illustrates the complete workflow process for the Jira Autopilot system, from ticket creation to deployment.

```mermaid
graph TD
    %% Define Styles
    classDef jira fill:#2684FF,stroke:#0052CC,stroke-width:2px,color:#fff;
    classDef auto fill:#FFD700,stroke:#B8860B,stroke-width:2px,color:#000;
    classDef gh fill:#24292e,stroke:#000,stroke-width:2px,color:#fff;
    classDef process fill:#4CAF50,stroke:#2E7D32,stroke-width:2px,color:#fff;
    
    %% Workflow Steps
    S1[Create Jira Ticket]
    S2[Autopilot Polls Jira]
    S3[Analyze Ticket Requirements]
    S4[Detect Project Language]
    S5[Generate CI/CD Workflow]
    S6["Upsert Files: Workflow and Dockerfile"]
    S7[Create Feature Branch]
    S8[Open Pull Request]
    S9[Run CI/CD Checks]
    S10[Review and Merge]
    S11[Deploy to Target]
    S12[Update Jira Ticket Status]
    
    %% Flow Connections
    S1 --> S2
    S2 --> S3
    S3 --> S4
    S4 --> S5
    S5 --> S6
    S6 --> S7
    S7 --> S8
    S8 --> S9
    S9 --> S10
    S10 --> S11
    S11 --> S12
    
    %% Apply Styles
    class S1,S12 jira
    class S2,S3 auto
    class S4,S5,S6 process
    class S7,S8,S9,S10,S11 gh
```

## Workflow Steps Explained

1. **Create Jira Ticket**: User creates a new ticket in Jira with requirements
2. **Autopilot Polls Jira**: System automatically polls Jira every 30 seconds
3. **Analyze Ticket Requirements**: Extracts repository, language, and deployment info
4. **Detect Project Language**: Identifies tech stack (Node.js, .NET, Python, Java)
5. **Generate CI/CD Workflow**: Creates GitHub Actions workflow file
6. **Upsert Files: Workflow and Dockerfile**: Updates or creates workflow files and Dockerfile
7. **Create Feature Branch**: Creates a feature branch for the changes
8. **Open Pull Request**: Opens a PR with the generated files
9. **Run CI/CD Checks**: Executes automated tests and builds
10. **Review and Merge**: Reviews PR and merges if checks pass
11. **Deploy to Target**: Deploys application to Azure or container registry
12. **Update Jira Ticket Status**: Marks ticket as complete in Jira
