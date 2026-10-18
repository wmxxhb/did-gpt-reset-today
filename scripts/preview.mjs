import { buildNotifications } from '../src/classify.mjs';
import { FEED_URL, getJson } from '../src/monitor.mjs';

const agent = process.env.SOURCE_USER_AGENT || 'DidGPTResetToday/0.1 (personal local preview; contact pending)';
try {
  const feed = await getJson(fetch, FEED_URL, { headers: { 'User-Agent': agent } });
  const notices = buildNotifications(feed);
  console.log(`数据更新：${feed.fetched_at}；过期标记：${feed.stale}`);
  console.log('以下仅预览历史消息，不发送微信通知。Data: https://codex-reset.com/\n');
  for (const n of notices.slice(-4)) console.log(`${n.content}\n${'—'.repeat(30)}\n`);
} catch {
  console.error('预览失败：请检查网络、SOURCE_USER_AGENT 或数据源状态。');
  process.exitCode = 1;
}
