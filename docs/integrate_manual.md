# Integration Manual: Repo Inspector & System Controls

## 1. Feature: Repository Inspector Integration

### Overview
The Repository Inspector allows users to manually select a GitHub repository from the UI, trigger a deep inspection, and automatically generate Jira tickets for any issues found (missing README, license, workflows, etc.).

### Implementation Details

#### Backend (`server.js`, `scripts/inspect_repo.js`)
*   **Refactoring**: The `scripts/inspect_repo.js` script was refactored to export its core logic via `processRepo(repoName, autoFix, logger)`. This allows `server.js` to invoke it programmaticall without spawning a separate child process for every call (though we could, function call is cleaner for log streaming).
*   **API Endpoints**:
    *   `GET /api/repos`: Lists all accessible repositories for the authenticated user/org. Uses `githubService.listAccessibleRepos`.
    *   `POST /api/inspect`: Accepts `{ repoName }`.
        *   Sets system status to `Scanning`.
        *   Invokes `processRepo`.
        *   Streams logs (via a callback) to `systemStatus.currentTicketLogs`, which the UI polls.
        *   Updates Jira tickets based on findings.

#### Frontend (`public/index.html`)
*   **Inspect Button**: Added a new "Inspect Repo" button to the Hero section.
*   **Inspection Modal**:
    *   Fetches the repository list when opened.
    *   Dropdown selection for repositories.
    *   "Start Inspection" button triggers the API.
*   **Live Feedback**: The existing log terminal in the UI automatically displays the inspection logs because the backend updates the shared `currentTicketLogs` array.

---

## 2. Feature: Pause Server Execution

### Overview
A "Pause/Resume" toggle has been added to the UI header. This allows operators to temporarily stop the automatic polling and processing of new Jira tickets (e.g., during maintenance or manual debugging).

### Implementation Details

#### Backend (`server.js`)
*   **State Management**: Added `systemStatus.paused` (boolean).
*   **Polling Logic**: The main `poll()` loop now checks `systemStatus.paused`.
    *   If `true`: It skips fetching/processing tickets and schedules the next check.
    *   Updates `systemStatus.currentPhase` to 'Paused' for UI visibility.
*   **API Endpoint**:
    *   `POST /api/pause`: Accepts `{ paused: boolean }`. Updates the server state.

#### Frontend (`public/index.html`)
*   **Header Control**: Added a Pause button in the top header.
    *   **State 'Resume'**: Button is Orange ("Pause").
    *   **State 'Paused'**: Button is Green ("Resume").
*   **Status Indicators**:
    *   The global timer badge shows "PAUSED" when the system is halted.
    *   Polling continues in the background to fetch status updates, ensuring the UI remains responsive to state changes.

---

## 3. Updated File Structure
*   `server.js`: Main Express server, now handles inspection and pause state.
*   `public/index.html`: Dashboard UI with new controls.
*   `scripts/inspect_repo.js`: Core inspection logic, now modular.
*   `src/services/`: Core business logic (`githubService.js`, `jiraService.js`).

## 4. Usage
1.  **Start Server**: `node server.js`
2.  **Inspect**: Click "Inspect Repo" -> Select Repo -> "Start Inspection". Watch logs.
3.  **Pause**: Click "Pause" in top right. System stops processing queue. Click "Resume" to continue.
