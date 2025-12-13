const http = require('http');

const data = JSON.stringify({
    issue: {
        fields: {
            customfield_repo: 'Unigalactix/sample-node-project',
            customfield_language: 'node',
            customfield_build: 'npm run build',
            customfield_test: 'npm test'
        }
    }
});

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/create-workflow',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
    }
};

const req = http.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
        console.log(`BODY: ${chunk}`);
    });
});

req.on('error', (e) => {
    console.error(`problem with request: ${e.message}`);
});

req.write(data);
req.end();
