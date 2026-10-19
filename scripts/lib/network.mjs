import { spawn } from 'node:child_process';

// The Windows wizard must use the same system proxy/certificate path as PowerShell.
// Secrets travel over stdin only, never as process arguments or temporary files.
const WINDOWS_REQUEST = `
[Console]::InputEncoding=[Text.Encoding]::UTF8
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
[void][Reflection.Assembly]::LoadWithPartialName('System.Web.Extensions')
$serializer=[System.Web.Script.Serialization.JavaScriptSerializer]::new()
$serializer.MaxJsonLength=2097152
$payload=$serializer.DeserializeObject([Console]::In.ReadToEnd())
$request=[Net.HttpWebRequest]::Create($payload['url'])
$request.Method=$payload['method']
$request.AllowAutoRedirect=$false
$request.ServicePoint.Expect100Continue=$false
$request.Timeout=[int]$payload['timeout']
$request.ReadWriteTimeout=[int]$payload['timeout']
$request.AutomaticDecompression=[Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
$request.UserAgent='DidGPTResetToday/0.1 (Windows)'
foreach($key in $payload['headers'].Keys) {
  if($key -ieq 'Content-Type') { $request.ContentType=$payload['headers'][$key] }
  elseif($key -ieq 'Accept') { $request.Accept=$payload['headers'][$key] }
  elseif($key -ieq 'User-Agent') { $request.UserAgent=$payload['headers'][$key] }
  else { $request.Headers[$key]=$payload['headers'][$key] }
}
if($null -ne $payload['body']) {
  $bytes=[Text.Encoding]::UTF8.GetBytes($payload['body'])
  $request.ContentLength=$bytes.Length
  $stream=$request.GetRequestStream()
  try { $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
}
$response=$null
try {
  try { $response=$request.GetResponse() }
  catch {
    $failure=$_.Exception
    while($failure.InnerException -and !$failure.Response) { $failure=$failure.InnerException }
    if($failure.Response) { $response=$failure.Response }
    else {
      $code='WINDOWS_NETWORK_FAILED'
      switch([string]$failure.Status) {
        'Timeout' { $code='ETIMEDOUT' }
        'NameResolutionFailure' { $code='ENOTFOUND' }
        'ProxyNameResolutionFailure' { $code='PROXY_DNS_FAILED' }
        'TrustFailure' { $code='CERTIFICATE_FAILED' }
        'SecureChannelFailure' { $code='TLS_FAILED' }
        'ConnectFailure' { $code='ECONNREFUSED' }
      }
      [Console]::Write($serializer.Serialize(@{ error=$code }))
      exit 0
    }
  }
  $reader=[IO.StreamReader]::new($response.GetResponseStream(),[Text.Encoding]::UTF8)
  try { $body=$reader.ReadToEnd() } finally { $reader.Dispose() }
  [Console]::Write($serializer.Serialize(@{ status=[int]$response.StatusCode; body=$body }))
} finally { if($response) { $response.Dispose() } }
`;

function networkError(code) {
  const error = new Error('Windows network request failed');
  error.code = code;
  return error;
}

export function windowsFetch(url, options = {}, { spawnProcess = spawn, timeoutMs = 30000 } = {}) {
  if (options.signal?.aborted) return Promise.reject(networkError('ETIMEDOUT'));
  return new Promise((resolve, reject) => {
    let output = '', settled = false;
    const child = spawnProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_REQUEST, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(response);
    };
    const abort = () => { child.kill(); finish(networkError('ETIMEDOUT')); };
    const timer = setTimeout(abort, timeoutMs + 3000);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 2097152) { child.kill(); finish(networkError('RESPONSE_TOO_LARGE')); }
    });
    child.stderr.resume(); // Never echo a native exception that could include a credential.
    child.on('error', () => finish(networkError('WINDOWS_NETWORK_UNAVAILABLE')));
    child.on('close', code => {
      if (settled) return;
      try {
        if (code !== 0) throw new Error();
        const data = JSON.parse(output.replace(/^\uFEFF/, ''));
        if (data.error) { finish(networkError(data.error)); return; }
        finish(null, new Response([204, 205, 304].includes(data.status) ? null : data.body, { status: data.status }));
      } catch { finish(networkError('WINDOWS_NETWORK_FAILED')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body ?? null, timeout: timeoutMs }));
  });
}

export function systemFetch(url, options) {
  return process.platform === 'win32' ? windowsFetch(url, options) : fetch(url, options);
}
