const fs = require('fs');
const path = require('path');
require('dotenv').config();

const requiredEnvVars = [
    'JIRA_BASE_URL',
    'JIRA_USER_EMAIL',
    'JIRA_API_TOKEN',
    'OAUTH_CLIENT_ID',
    'OAUTH_CLIENT_SECRET',
    // 'GHUB_TOKEN', // Optional if OAuth is used
    'LLM_API_KEY',
    'LLM_ENDPOINT',
    'LLM_DEPLOYMENT_NAME', // Corrected name
    'LLM_VERSION'
];

const deprecatedEnvVars = [
    'LLM_DEPLOYEMENT_NAME', // Typo
    // 'GITHUB_APP_ID', // Kept for app auth reference, maybe verify if present
    // 'GITHUB_PRIVATE_KEY'
];

let errors = [];
let warnings = [];

console.log('--- Verifying Configuration ---');

// Check Required Vars
requiredEnvVars.forEach(key => {
    if (!process.env[key]) {
        errors.push(`Missing required environment variable: ${key}`);
    }
});

// Check Deprecated Vars
deprecatedEnvVars.forEach(key => {
    if (process.env[key]) {
        warnings.push(`Found deprecated environment variable: ${key}. Please use the correct key.`);
    }
});

// Check File Existence
const requiredFiles = [
    '.env',
    'server.js',
    'package.json',
    'src/services/githubService.js',
    'src/services/jiraService.js',
    'src/services/llmService.js'
];

requiredFiles.forEach(file => {
    if (!fs.existsSync(path.resolve(__dirname, '..', file))) {
        errors.push(`Missing required file: ${file}`);
    }
});

// Output Results
if (warnings.length > 0) {
    console.warn('\n⚠️  Warnings:');
    warnings.forEach(w => console.warn(`- ${w}`));
}

if (errors.length > 0) {
    console.error('\n❌ Configuration Errors:');
    errors.forEach(e => console.error(`- ${e}`));
    process.exit(1);
} else {
    console.log('\n✅ Configuration is valid!');
}
