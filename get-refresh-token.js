// get-refresh-token.js
const http = require('http');
const https = require('https');
const { URL } = require('url');
const querystring = require('querystring');
require('dotenv').config();

const CLIENT_ID = process.env.AUTH_KEY_CLIENT_ID;
const CLIENT_SECRET = process.env.AUTH_KEY_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:5353/oauth2callback';
const SCOPES = ['https://www.googleapis.com/auth/drive'];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en env');
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');
authUrl.searchParams.set('include_granted_scopes', 'true');
authUrl.searchParams.set('scope', SCOPES.join(' '));

console.log('\nAbre este URL en tu navegador:\n');
console.log(authUrl.toString(), '\n');

const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.statusCode = 404;
    return res.end('Not Found');
  }

  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.end('Error: ' + error);
    console.error('OAuth error:', error);
    return server.close();
  }

  res.end('OK. Ya puedes cerrar esta pestaña.');
  server.close();

  const postData = querystring.stringify({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code'
  });

  const tokenReq = https.request(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    },
    (tokenRes) => {
      let body = '';
      tokenRes.on('data', (chunk) => (body += chunk));
      tokenRes.on('end', () => {
        try {
          const data = JSON.parse(body);
          console.log('\nREFRESH TOKEN:\n', data.refresh_token || '(no vino refresh_token)');
          console.log('\nRespuesta completa:\n', data);
        } catch (e) {
          console.error('Error parseando respuesta:', body);
        }
      });
    }
  );

  tokenReq.on('error', (err) => console.error('Token request error:', err));
  tokenReq.write(postData);
  tokenReq.end();
});

server.listen(5353, () => {
  console.log('Servidor local escuchando en http://localhost:5353');
});
