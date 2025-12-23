const https = require('https');
require('dotenv').config();

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_USER_EMAIL;
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;

// Create Auth Header
const authHeader = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

console.log('Connecting to Jira:', JIRA_BASE_URL);

async function getAllProjects() {
    return new Promise((resolve, reject) => {
        // Use clean URL construction
        const url = new URL(`${JIRA_BASE_URL}/rest/api/3/project`);

        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
                'Authorization': authHeader,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`Failed to parse JSON: ${e.message}`));
                    }
                } else {
                    reject(new Error(`Jira API returned: ${res.statusCode} ${data}`));
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.end();
    });
}

// Run
getAllProjects().then(projects => {
    const fs = require('fs');
    console.log(`\n✅ Success! Found ${projects.length} projects.\n`);

    // Write detailed JSON for reliable reading
    fs.writeFileSync('projects_list.json', JSON.stringify(projects, null, 2));
    console.log('Saved list to projects_list.json');


}).catch(err => {
    console.error("\n❌ Error fetching projects:");
    console.error(err.message);
});
