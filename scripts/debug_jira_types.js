const https = require('https');
require('dotenv').config();

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_USER_EMAIL;
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = 'INS';

if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_TOKEN) {
    console.error('Missing env vars');
    process.exit(1);
}

const authHeader = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

const options = {
    hostname: new URL(JIRA_BASE_URL).hostname,
    path: `/rest/api/3/issue/createmeta?projectKeys=${PROJECT_KEY}&expand=projects.issuetypes.fields`,
    method: 'GET',
    headers: {
        'Authorization': authHeader,
        'Accept': 'application/json'
    }
};

const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        if (res.statusCode === 200) {
            const json = JSON.parse(data);
            if (json.projects && json.projects.length > 0) {
                const types = json.projects[0].issuetypes;
                console.log(`Valid Issue Types for ${PROJECT_KEY}:`);
                types.forEach(t => console.log(`- ${t.name} (ID: ${t.id})`));
            } else {
                console.log(`Project ${PROJECT_KEY} not found or no create permission.`);
            }
        } else {
            console.error(`Error ${res.statusCode}: ${data}`);
        }
    });
});

req.on('error', (e) => console.error(e));
req.end();
