// EXPERIMENT, do not merge: a deliberate code injection and reflected XSS so
// the CodeQL JavaScript analysis must raise new alerts on this pull request.
const http = require('node:http');

http
  .createServer((request, response) => {
    const parameters = new URL(request.url, 'http://localhost').searchParams;
    const result = eval(parameters.get('code'));
    response.setHeader('content-type', 'text/html');
    response.end(`<h1>${parameters.get('name')}</h1><p>${result}</p>`);
  })
  .listen(0);
