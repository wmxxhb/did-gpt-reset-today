export async function localRequest(path, body, fetcher = globalThis.fetch) {
  let response;
  try {
    response = await fetcher('/api/' + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(40000),
    });
  } catch (error) {
    const timeout = ['TimeoutError', 'AbortError'].includes(error?.name);
    throw Object.assign(new Error(timeout
      ? '本机网页后台响应超时，请稍后重试；如果仍无响应，请重新打开“打开网页版.cmd”。'
      : '本机网页后台已断开，可能已关闭或重新启动。请重新双击“打开网页版.cmd”，使用自动打开的新页面，并关闭旧标签页。云端监控仍会继续。'),
    { code: timeout ? 'local_timeout' : 'local_unreachable' });
  }
  let result;
  try { result = await response.json(); }
  catch { throw Object.assign(new Error('本机网页返回了异常内容，请重新打开“打开网页版.cmd”。'), { code: 'invalid_response' }); }
  if (!response.ok) throw Object.assign(new Error(result.error || '操作未完成，请重试。'), { code: response.status === 401 ? 'local_session_expired' : 'api_error' });
  return result;
}
